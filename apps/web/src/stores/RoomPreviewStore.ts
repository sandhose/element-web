/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import {
    ClientEvent,
    type EmptyObject,
    type MatrixClient,
    MatrixError,
    type RoomSummary,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership, type Membership } from "matrix-js-sdk/src/types";
import { logger } from "matrix-js-sdk/src/logger";

import defaultDispatcher, { type MatrixDispatcher } from "../dispatcher/dispatcher";
import { type ActionPayload } from "../dispatcher/payloads";
import { type ActiveRoomChangedPayload } from "../dispatcher/payloads/ActiveRoomChangedPayload";
import { Action } from "../dispatcher/actions";
import { AsyncStoreWithClient } from "./AsyncStoreWithClient";

/**
 * Why a room has no summary.
 * - `notFound`: the server does not know the room.
 * - `forbidden`: the server knows it but will not describe it to us.
 * - `unavailable`: the request failed for any other reason, including a server without MSC3266.
 */
export type PreviewError = "notFound" | "forbidden" | "unavailable";

/** What is known about a room the user is not in. */
export interface RoomPreview {
    summary: RoomSummary | null;
    error: PreviewError | null;
}

interface OwnedPreview extends RoomPreview {
    /** Whether this store put the `Room` into `client.store` and so has to take it out again. */
    hydrated: boolean;
    /** Our membership in the hydrated room; a different one means `/sync` has taken it over. */
    hydratedMembership?: Membership;
}

interface RoomPreviewRequestOpts {
    /** The alias to fetch the summary by, which works over federation without via servers. */
    roomAlias?: string;
    viaServers?: string[];
}

function classifyError(e: unknown): PreviewError {
    if (e instanceof MatrixError) {
        if (e.errcode === "M_NOT_FOUND") return "notFound";
        if (e.errcode === "M_FORBIDDEN") return "forbidden";
    }
    return "unavailable";
}

/**
 * The MSC3266 summaries of the rooms the user is not in, and the `Room` objects hydrated from them.
 *
 * A room the user is not joined to or invited to has no `Room` in `client.store` at all, or a stale
 * one from before they left. Its summary is the display source of truth either way, and the
 * hydrated `Room` exists only so that everything which reads a `Room` has something to key on.
 */
export class RoomPreviewStore extends AsyncStoreWithClient<EmptyObject> {
    private static _instance?: RoomPreviewStore;
    public static get instance(): RoomPreviewStore {
        if (!RoomPreviewStore._instance) {
            RoomPreviewStore._instance = new RoomPreviewStore(defaultDispatcher);
            void RoomPreviewStore._instance.start();
        }
        return RoomPreviewStore._instance;
    }

    private readonly previews = new Map<string, OwnedPreview>();
    private readonly requests = new Map<string, Promise<RoomPreview | null>>();

    public constructor(dispatcher: MatrixDispatcher) {
        super(dispatcher);
    }

    protected async onAction(payload: ActionPayload): Promise<void> {
        if (payload.action !== Action.ActiveRoomChanged) return;
        const { oldRoomId } = payload as ActiveRoomChangedPayload;
        if (oldRoomId) this.release(oldRoomId);
    }

    protected async onNotReady(): Promise<void> {
        for (const roomId of Array.from(this.previews.keys())) {
            this.release(roomId);
        }
        this.requests.clear();
    }

    /**
     * Fetch the summary of a room the user may not be in, and hydrate a `Room` from it if the
     * store holds none. Resolves once there is nothing more to wait for, and never rejects.
     *
     * @param roomId - The room to describe.
     * @param opts - How to reach the room.
     * @returns The preview, or null if the room needs none because the user is in it.
     */
    public request(roomId: string, opts: RoomPreviewRequestOpts = {}): Promise<RoomPreview | null> {
        const pending = this.requests.get(roomId);
        if (pending) return pending;

        const existing = this.previews.get(roomId);
        if (existing) return Promise.resolve(existing);

        const client = this.matrixClient;
        if (!client) return Promise.resolve(null);

        const membership = client.getRoom(roomId)?.getMyMembership();
        if (membership === KnownMembership.Join || membership === KnownMembership.Invite) {
            return Promise.resolve(null);
        }

        const inFlight: OwnedPreview = { summary: null, error: null, hydrated: false };
        this.previews.set(roomId, inFlight);

        const request = this.fetch(client, roomId, inFlight, opts);
        this.requests.set(roomId, request);
        void request.finally(() => {
            if (this.requests.get(roomId) === request) this.requests.delete(roomId);
        });
        return request;
    }

    private async fetch(
        client: MatrixClient,
        roomId: string,
        inFlight: OwnedPreview,
        opts: RoomPreviewRequestOpts,
    ): Promise<RoomPreview> {
        let summary: RoomSummary | null = null;
        let error: PreviewError | null = null;
        try {
            summary = await client.getRoomSummary(opts.roomAlias ?? roomId, opts.viaServers);
        } catch (e) {
            error = classifyError(e);
            logger.warn(`RoomPreviewStore: no summary for ${roomId} (${error})`, e);
        }

        const settled: OwnedPreview = { summary, error, hydrated: false };
        // The room was released while the request was in flight, so nothing is left to evict what
        // hydration would create.
        if (this.previews.get(roomId) !== inFlight) return settled;

        // A world-readable room is peeked instead, and peeking builds and stores its own `Room`.
        // A room the user left keeps the state it had then: the summary is what is current.
        if (summary && !summary.world_readable && client.getRoom(roomId) === null) {
            const room = client.hydrateRoomFromSummary(summary);
            settled.hydrated = true;
            settled.hydratedMembership = room.getMyMembership();
        }

        this.previews.set(roomId, settled);
        return settled;
    }

    /** What is known about a room right now; a preview with neither summary nor error is in flight. */
    public get(roomId: string): RoomPreview | null {
        return this.previews.get(roomId) ?? null;
    }

    /** Whether the `Room` in the store for this id is one this store hydrated. */
    public isPreviewRoom(roomId: string): boolean {
        return this.previews.get(roomId)?.hydrated === true;
    }

    /**
     * Forget a room's summary and take the `Room` hydrated from it back out of the store, leaving
     * any room `/sync` has since taken over alone.
     */
    public release(roomId: string): void {
        const preview = this.previews.get(roomId);
        if (!preview) return;
        this.previews.delete(roomId);
        // A request in flight will drop its result, so a later view of the room has to start its
        // own rather than wait on this one.
        this.requests.delete(roomId);

        const client = this.matrixClient;
        const room = client?.getRoom(roomId);
        if (preview.hydrated && client && room?.getMyMembership() === preview.hydratedMembership) {
            client.store.removeRoom(roomId);
            client.emit(ClientEvent.DeleteRoom, roomId);
        }
    }
}
