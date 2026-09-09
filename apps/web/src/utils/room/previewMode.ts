/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { JoinRule } from "matrix-js-sdk/src/matrix";
import { KnownMembership, type Membership } from "matrix-js-sdk/src/types";

/** Which subtree owns the screen for the room being viewed. */
export enum PreviewMode {
    /** Nothing is known about the room yet. */
    Loading,
    /** The server does not know the room. */
    NotFound,
    /** The server knows the room but will not describe it to us. */
    Forbidden,
    /** The user is banned from the room. */
    Banned,
    /** The room is described by a bar, with no timeline and no widget. */
    Bar,
    /** A call room the user can enter or ask to enter, previewed in the Element Call lobby. */
    Lobby,
    /** The room itself: timeline, composer, widgets. */
    Full,
}

/**
 * The one action which applies to the user for a room they are not in.
 * - `join`: joining will succeed.
 * - `ask`: the room is knockable and knocking is enabled.
 * - `waiting`: the user has knocked and no one has answered yet.
 * - `denied`: someone refused the user's knock.
 * - `banned`: the user is banned.
 * - `needInvite`: only an invite gets the user in.
 * - `notAllowed`: the room is restricted to rooms the user is not in.
 * - `invited`: the user has an invite to accept or decline.
 */
export interface PreviewCta {
    kind: "join" | "ask" | "waiting" | "denied" | "banned" | "needInvite" | "notAllowed" | "invited";
    /** The rooms whose members may join this room, or the ones the user is in if they are allowed. */
    allowedVia: string[];
}

/** How far the MSC3266 summary of the room being viewed has got. */
type SummaryState = "pending" | "loaded" | "notFound" | "forbidden" | "unavailable";

/** Everything the preview decision reads, resolved from the room, its summary and settings. */
export interface PreviewInput {
    /** Whether this is an MSC3417 call room, from the summary if there is one, else the room. */
    isCallRoom: boolean;
    /** The user's membership, from the room if there is one, else from the summary. */
    membership: Membership | undefined;
    /** Whether our own `m.room.member` event replaced a knock. */
    wasKnocking: boolean;
    /** Whether someone else refused that knock, as opposed to the user withdrawing it. */
    knockDenied: boolean;
    /** The join rule, from room state if there is any, else from the summary. */
    joinRule: string | undefined;
    /** The rooms named by the join rule's allow list, else `summary.allowed_room_ids`. */
    allowedRoomIds: string[];
    /** The subset of {@link allowedRoomIds} the user is joined to. */
    joinedAllowedRoomIds: string[];
    /** Whether the room is world-readable, so its timeline can be shown without joining. */
    canPeek: boolean;
    /** Whether a `Room` exists, whether synced or hydrated from the summary. */
    hasRoom: boolean;
    summaryState: SummaryState;
    /** Whether a join has been refused with a 403, which offers a knock on any join rule. */
    promptAskToJoin: boolean;
    askToJoinEnabled: boolean;
    /** Whether Element Call can run as a video room, and has a transport to connect through. */
    callLobbyAvailable: boolean;
}

/** Whether the CTA is a step of a knock's lifecycle, which the preview bar owns from end to end. */
export function isKnockCta(cta: PreviewCta): boolean {
    return cta.kind === "ask" || cta.kind === "waiting" || cta.kind === "denied";
}

export function computePreviewCta(i: PreviewInput): PreviewCta {
    switch (i.membership ?? KnownMembership.Leave) {
        case KnownMembership.Ban:
            return { kind: "banned", allowedVia: [] };
        case KnownMembership.Invite:
            return { kind: "invited", allowedVia: [] };
        case KnownMembership.Knock:
            return { kind: "waiting", allowedVia: [] };
        case KnownMembership.Join:
            return { kind: "join", allowedVia: [] };
    }

    if (i.knockDenied) return { kind: "denied", allowedVia: [] };
    // A refused join is the only signal on a server which cannot describe the room, so it offers a
    // knock whatever the join rule looks like.
    if (i.promptAskToJoin && i.askToJoinEnabled) return { kind: "ask", allowedVia: [] };

    const knock = i.askToJoinEnabled
        ? { kind: "ask" as const, allowedVia: [] }
        : { kind: "needInvite" as const, allowedVia: [] };

    switch (i.joinRule) {
        case JoinRule.Public:
            return { kind: "join", allowedVia: [] };
        case JoinRule.Restricted:
            return i.joinedAllowedRoomIds.length > 0
                ? { kind: "join", allowedVia: i.joinedAllowedRoomIds }
                : { kind: "notAllowed", allowedVia: i.allowedRoomIds };
        case JoinRule.KnockRestricted:
            return i.joinedAllowedRoomIds.length > 0 ? { kind: "join", allowedVia: i.joinedAllowedRoomIds } : knock;
        case JoinRule.Knock:
            return knock;
        default:
            return { kind: "needInvite", allowedVia: [] };
    }
}

/**
 * Whether the room should be previewed inside the Element Call lobby, which needs a call room, a
 * usable Element Call, and something the user can do there worth the cost of booting the widget.
 */
function isLobbyPreview(i: PreviewInput): boolean {
    if (!i.isCallRoom || !i.callLobbyAvailable) return false;

    switch (computePreviewCta(i).kind) {
        case "join":
        case "ask":
        case "waiting":
            return i.membership !== KnownMembership.Join;
        case "invited":
            // A plain invite needs the bar's accept and decline; an approved knock does not.
            return i.wasKnocking;
        default:
            return false;
    }
}

export function computePreviewMode(i: PreviewInput): PreviewMode {
    if (i.membership === KnownMembership.Join) return PreviewMode.Full;
    if (!i.hasRoom && i.summaryState === "pending") return PreviewMode.Loading;
    if (i.summaryState === "notFound") return PreviewMode.NotFound;
    if (!i.hasRoom && (i.summaryState === "forbidden" || i.summaryState === "unavailable")) {
        return PreviewMode.Forbidden;
    }
    if (i.membership === KnownMembership.Ban) return PreviewMode.Banned;
    if (isLobbyPreview(i)) return PreviewMode.Lobby;
    // A knock in flight outranks a peek: the user needs to see the request they made.
    if (isKnockCta(computePreviewCta(i))) return PreviewMode.Bar;
    if (i.canPeek) return PreviewMode.Full;
    return PreviewMode.Bar;
}
