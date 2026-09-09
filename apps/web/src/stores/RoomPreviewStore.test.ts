/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { ClientEvent, type MatrixClient, MatrixError, Room, type RoomSummary } from "matrix-js-sdk/src/matrix";
import { KnownMembership, type Membership } from "matrix-js-sdk/src/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupAsyncStoreWithClient, stubClient } from "test-utils";

import { RoomPreviewStore } from "./RoomPreviewStore";
import { MatrixDispatcher } from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { type ActiveRoomChangedPayload } from "../dispatcher/payloads/ActiveRoomChangedPayload";

describe("RoomPreviewStore", () => {
    const roomId = "!room:server";
    const otherRoomId = "!other:server";
    const userId = "@userId:matrix.org";

    let client: MatrixClient;
    let dis: MatrixDispatcher;
    let store: RoomPreviewStore;
    let rooms: Map<string, Room>;

    const summaryFor = (id: string, extra: Partial<RoomSummary> = {}): RoomSummary =>
        ({
            room_id: id,
            name: "A room",
            world_readable: false,
            guest_can_join: false,
            num_joined_members: 3,
            ...extra,
        }) as RoomSummary;

    const makeRoom = (id: string, membership?: Membership): Room => {
        const room = new Room(id, client, userId);
        if (membership) room.updateMyMembership(membership);
        rooms.set(id, room);
        return room;
    };

    beforeEach(async () => {
        rooms = new Map();
        client = stubClient();
        client.getRoomSummary = vi.fn().mockResolvedValue(summaryFor(roomId));
        client.hydrateRoomFromSummary = vi.fn((summary: RoomSummary) => makeRoom(summary.room_id, summary.membership));
        vi.mocked(client.getRoom).mockImplementation((id?: string) => (id ? (rooms.get(id) ?? null) : null));

        dis = new MatrixDispatcher();
        store = new RoomPreviewStore(dis);
        await setupAsyncStoreWithClient(store, client);
    });

    describe("request", () => {
        it.each([KnownMembership.Join, KnownMembership.Invite])("is skipped for a %s room", async (membership) => {
            makeRoom(roomId, membership);

            await expect(store.request(roomId)).resolves.toBeNull();
            expect(client.getRoomSummary).not.toHaveBeenCalled();
            expect(store.get(roomId)).toBeNull();
        });

        it.each([KnownMembership.Leave, KnownMembership.Knock, KnownMembership.Ban])(
            "fetches the summary of a %s room",
            async (membership) => {
                makeRoom(roomId, membership);

                const preview = await store.request(roomId);
                expect(client.getRoomSummary).toHaveBeenCalledWith(roomId, undefined);
                expect(preview?.summary?.name).toBe("A room");
            },
        );

        it("fetches the summary of a room the store does not know", async () => {
            const preview = await store.request(roomId, { roomAlias: "#room:server", viaServers: ["server"] });
            expect(client.getRoomSummary).toHaveBeenCalledWith("#room:server", ["server"]);
            expect(preview?.summary?.name).toBe("A room");
        });

        it("holds an empty preview until the summary arrives", async () => {
            const request = store.request(roomId);
            expect(store.get(roomId)).toEqual({ summary: null, error: null, hydrated: false });

            await request;
            expect(store.get(roomId)?.summary?.name).toBe("A room");
        });

        it("hydrates a Room when the store has none", async () => {
            await store.request(roomId);

            expect(client.hydrateRoomFromSummary).toHaveBeenCalledWith(summaryFor(roomId));
            expect(store.isPreviewRoom(roomId)).toBe(true);
        });

        it("does not hydrate a world-readable room, which is peeked instead", async () => {
            vi.mocked(client.getRoomSummary).mockResolvedValue(summaryFor(roomId, { world_readable: true }));

            const preview = await store.request(roomId);
            expect(preview?.summary?.world_readable).toBe(true);
            expect(client.hydrateRoomFromSummary).not.toHaveBeenCalled();
            expect(store.isPreviewRoom(roomId)).toBe(false);
        });

        it("does not hydrate over an existing Room", async () => {
            makeRoom(roomId, KnownMembership.Leave);

            await store.request(roomId);
            expect(client.hydrateRoomFromSummary).not.toHaveBeenCalled();
            expect(store.isPreviewRoom(roomId)).toBe(false);
        });

        it.each([
            ["M_NOT_FOUND", "notFound"],
            ["M_FORBIDDEN", "forbidden"],
        ])("resolves with %s classified as %s", async (errcode, error) => {
            vi.mocked(client.getRoomSummary).mockRejectedValue(new MatrixError({ errcode }, 404));

            const preview = await store.request(roomId);
            expect(preview).toEqual(expect.objectContaining({ summary: null, error }));
            expect(client.hydrateRoomFromSummary).not.toHaveBeenCalled();
        });

        it("resolves with any other failure classified as unavailable", async () => {
            vi.mocked(client.getRoomSummary).mockRejectedValue(new Error("no such endpoint"));

            const preview = await store.request(roomId);
            expect(preview).toEqual(expect.objectContaining({ error: "unavailable" }));
        });

        it("shares one request between concurrent callers", async () => {
            const [first, second] = await Promise.all([store.request(roomId), store.request(roomId)]);
            expect(first).toBe(second);
            expect(client.getRoomSummary).toHaveBeenCalledTimes(1);
        });

        it("answers from the settled preview rather than fetching again", async () => {
            const first = await store.request(roomId, { viaServers: ["server"] });

            await expect(store.request(roomId)).resolves.toBe(first);
            expect(client.getRoomSummary).toHaveBeenCalledOnce();
        });

        it("waits for the client before it can fetch, and then fetches once", async () => {
            const early = new RoomPreviewStore(new MatrixDispatcher());

            await expect(early.request(roomId)).resolves.toBeNull();
            expect(client.getRoomSummary).not.toHaveBeenCalled();

            await setupAsyncStoreWithClient(early, client);
            const preview = await early.request(roomId);

            expect(preview?.summary?.name).toBe("A room");
            await expect(early.request(roomId)).resolves.toBe(preview);
            expect(client.getRoomSummary).toHaveBeenCalledOnce();
        });
    });

    describe("release", () => {
        it("removes the hydrated Room and announces it", async () => {
            await store.request(roomId);
            const deleted = vi.fn();
            client.on(ClientEvent.DeleteRoom, deleted);

            store.release(roomId);
            expect(client.store.removeRoom).toHaveBeenCalledWith(roomId);
            expect(deleted).toHaveBeenCalledWith(roomId);
            expect(store.get(roomId)).toBeNull();
            expect(store.isPreviewRoom(roomId)).toBe(false);
        });

        it("leaves a Room /sync has taken over alone", async () => {
            await store.request(roomId);
            rooms.get(roomId)!.updateMyMembership(KnownMembership.Knock);

            store.release(roomId);
            expect(client.store.removeRoom).not.toHaveBeenCalled();
            expect(store.get(roomId)).toBeNull();
        });

        it("leaves a Room it did not hydrate alone", async () => {
            makeRoom(roomId, KnownMembership.Leave);
            await store.request(roomId);

            store.release(roomId);
            expect(client.store.removeRoom).not.toHaveBeenCalled();
        });

        it("lets a room released while its summary was in flight be requested again", async () => {
            const dropped = store.request(roomId);
            store.release(roomId);

            const preview = await store.request(roomId);
            await dropped;

            expect(client.getRoomSummary).toHaveBeenCalledTimes(2);
            expect(store.get(roomId)).toBe(preview);
            expect(store.isPreviewRoom(roomId)).toBe(true);
        });
    });

    it("releases the previously active room when the active room changes", async () => {
        await store.request(roomId);

        dis.dispatch<ActiveRoomChangedPayload>(
            { action: Action.ActiveRoomChanged, oldRoomId: roomId, newRoomId: null },
            true,
        );
        expect(client.store.removeRoom).toHaveBeenCalledWith(roomId);
    });

    it("releases every room on logout", async () => {
        vi.mocked(client.getRoomSummary).mockImplementation(async (id: string) => summaryFor(id));
        await store.request(roomId);
        await store.request(otherRoomId);

        // @ts-ignore protected access
        await store.onNotReady();
        expect(client.store.removeRoom).toHaveBeenCalledWith(roomId);
        expect(client.store.removeRoom).toHaveBeenCalledWith(otherRoomId);
        expect(store.get(roomId)).toBeNull();
        expect(store.get(otherRoomId)).toBeNull();
    });
});
