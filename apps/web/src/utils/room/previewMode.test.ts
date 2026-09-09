/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { describe, expect, it } from "vitest";
import { JoinRule } from "matrix-js-sdk/src/matrix";
import { KnownMembership, type Membership } from "matrix-js-sdk/src/types";

import { computePreviewCta, computePreviewMode, PreviewMode, type PreviewCta, type PreviewInput } from "./previewMode";

/** A room the user has never been in, described by a loaded summary, with every flag on. */
function input(overrides: Partial<PreviewInput> = {}): PreviewInput {
    return {
        isCallRoom: false,
        membership: KnownMembership.Leave,
        wasKnocking: false,
        knockDenied: false,
        joinRule: JoinRule.Invite,
        allowedRoomIds: [],
        joinedAllowedRoomIds: [],
        canPeek: false,
        hasRoom: true,
        summaryState: "loaded",
        promptAskToJoin: false,
        askToJoinEnabled: true,
        callLobbyAvailable: true,
        ...overrides,
    };
}

/** The same, for a room previewed in the Element Call lobby. */
function callRoom(overrides: Partial<PreviewInput> = {}): PreviewInput {
    return input({ isCallRoom: true, joinRule: JoinRule.Knock, ...overrides });
}

describe("computePreviewCta", () => {
    it.each<[string, Partial<PreviewInput>, PreviewCta]>([
        ["public", { joinRule: JoinRule.Public }, { kind: "join", allowedVia: [] }],
        [
            "restricted and allowed",
            { joinRule: JoinRule.Restricted, allowedRoomIds: ["!a:s", "!b:s"], joinedAllowedRoomIds: ["!b:s"] },
            { kind: "join", allowedVia: ["!b:s"] },
        ],
        [
            "restricted and not allowed",
            { joinRule: JoinRule.Restricted, allowedRoomIds: ["!a:s"] },
            { kind: "notAllowed", allowedVia: ["!a:s"] },
        ],
        ["knock", { joinRule: JoinRule.Knock }, { kind: "ask", allowedVia: [] }],
        [
            "knock_restricted and allowed",
            { joinRule: JoinRule.KnockRestricted, allowedRoomIds: ["!a:s"], joinedAllowedRoomIds: ["!a:s"] },
            { kind: "join", allowedVia: ["!a:s"] },
        ],
        [
            "knock_restricted and not allowed",
            { joinRule: JoinRule.KnockRestricted, allowedRoomIds: ["!a:s"] },
            { kind: "ask", allowedVia: [] },
        ],
        ["invite", { joinRule: JoinRule.Invite }, { kind: "needInvite", allowedVia: [] }],
        ["an unknown join rule", { joinRule: "org.example.rule" }, { kind: "needInvite", allowedVia: [] }],
        ["no join rule at all", { joinRule: undefined }, { kind: "needInvite", allowedVia: [] }],
    ])("gives the CTA of a %s room", (_name, overrides, expected) => {
        expect(computePreviewCta(input(overrides))).toEqual(expected);
    });

    it.each<[Membership, PreviewCta["kind"]]>([
        [KnownMembership.Ban, "banned"],
        [KnownMembership.Invite, "invited"],
        [KnownMembership.Knock, "waiting"],
        [KnownMembership.Join, "join"],
    ])("lets membership %s decide the CTA over the join rule", (membership, kind) => {
        expect(computePreviewCta(input({ membership, joinRule: JoinRule.Public })).kind).toEqual(kind);
    });

    it("reports a denied knock rather than the ask which led to it", () => {
        const denied = input({ joinRule: JoinRule.Knock, wasKnocking: true, knockDenied: true });
        expect(computePreviewCta(denied).kind).toEqual("denied");
    });

    it("offers the ask again once the user withdrew their own request", () => {
        const cancelled = input({ joinRule: JoinRule.Knock, wasKnocking: true });
        expect(computePreviewCta(cancelled).kind).toEqual("ask");
    });

    it("collapses knockable rooms to needing an invite with the flag off", () => {
        expect(computePreviewCta(input({ joinRule: JoinRule.Knock, askToJoinEnabled: false })).kind).toEqual(
            "needInvite",
        );
        expect(computePreviewCta(input({ joinRule: JoinRule.KnockRestricted, askToJoinEnabled: false })).kind).toEqual(
            "needInvite",
        );
    });

    it("offers the ask after a refused join even with an unknown join rule", () => {
        expect(computePreviewCta(input({ joinRule: undefined, promptAskToJoin: true })).kind).toEqual("ask");
    });

    it("keeps a denied knock denied after a refused join", () => {
        expect(computePreviewCta(input({ promptAskToJoin: true, wasKnocking: true, knockDenied: true })).kind).toEqual(
            "denied",
        );
    });
});

describe("computePreviewMode", () => {
    it("renders the room itself for a member", () => {
        expect(computePreviewMode(input({ membership: KnownMembership.Join, canPeek: false }))).toEqual(
            PreviewMode.Full,
        );
    });

    it("renders the room itself for a world-readable room the user is not in", () => {
        expect(computePreviewMode(input({ canPeek: true }))).toEqual(PreviewMode.Full);
    });

    it.each<[PreviewCta["kind"], Partial<PreviewInput>]>([
        ["ask", { joinRule: JoinRule.Knock }],
        ["waiting", { membership: KnownMembership.Knock }],
        ["denied", { wasKnocking: true, knockDenied: true }],
    ])("keeps a %s knock in the bar even where the room can be peeked", (_kind, overrides) => {
        expect(computePreviewMode(input({ canPeek: true, ...overrides }))).toEqual(PreviewMode.Bar);
    });

    it("waits while the summary is pending and there is no room", () => {
        expect(computePreviewMode(input({ hasRoom: false, summaryState: "pending" }))).toEqual(PreviewMode.Loading);
    });

    it("does not wait for the summary of a room it already has", () => {
        expect(computePreviewMode(input({ hasRoom: true, summaryState: "pending" }))).toEqual(PreviewMode.Bar);
    });

    it("reports a room the server does not know even where one is in the store", () => {
        expect(computePreviewMode(input({ hasRoom: true, summaryState: "notFound" }))).toEqual(PreviewMode.NotFound);
    });

    it.each<[PreviewInput["summaryState"]]>([["forbidden"], ["unavailable"]])(
        "reports a summary the server refused (%s) as forbidden",
        (summaryState) => {
            expect(computePreviewMode(input({ hasRoom: false, summaryState }))).toEqual(PreviewMode.Forbidden);
        },
    );

    it("describes a room whose summary was refused but which is in the store", () => {
        expect(computePreviewMode(input({ hasRoom: true, summaryState: "forbidden" }))).toEqual(PreviewMode.Bar);
    });

    it("reports a ban ahead of every other preview", () => {
        expect(computePreviewMode(input({ membership: KnownMembership.Ban, canPeek: true }))).toEqual(
            PreviewMode.Banned,
        );
    });

    it.each<[string, Partial<PreviewInput>, PreviewMode]>([
        ["never in it and it is knockable", {}, PreviewMode.Lobby],
        ["never in it and it is public", { joinRule: JoinRule.Public }, PreviewMode.Lobby],
        ["never in it and it is invite-only", { joinRule: JoinRule.Invite }, PreviewMode.Bar],
        ["not allowed into it", { joinRule: JoinRule.Restricted, allowedRoomIds: ["!a:s"] }, PreviewMode.Bar],
        ["knocking", { membership: KnownMembership.Knock }, PreviewMode.Lobby],
        ["denied", { wasKnocking: true, knockDenied: true }, PreviewMode.Bar],
        ["having withdrawn the request", { wasKnocking: true }, PreviewMode.Lobby],
        ["invited after knocking", { membership: KnownMembership.Invite, wasKnocking: true }, PreviewMode.Lobby],
        ["plainly invited", { membership: KnownMembership.Invite }, PreviewMode.Bar],
        ["banned", { membership: KnownMembership.Ban }, PreviewMode.Banned],
        ["joined", { membership: KnownMembership.Join }, PreviewMode.Full],
        ["not able to knock", { askToJoinEnabled: false }, PreviewMode.Bar],
        ["without a usable Element Call", { callLobbyAvailable: false }, PreviewMode.Bar],
    ])("picks the surface for a call room the user is %s", (_name, overrides, expected) => {
        expect(computePreviewMode(callRoom(overrides))).toEqual(expected);
    });

    it("never puts a room which is not a call room in the lobby", () => {
        expect(computePreviewMode(callRoom({ isCallRoom: false }))).toEqual(PreviewMode.Bar);
    });

    it("describes a room the user cannot enter with the bar", () => {
        expect(computePreviewMode(input({ joinRule: JoinRule.Invite }))).toEqual(PreviewMode.Bar);
    });
});
