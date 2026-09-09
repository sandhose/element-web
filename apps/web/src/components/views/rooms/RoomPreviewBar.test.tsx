/*
Copyright 2024 New Vector Ltd.
Copyright 2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React, { type ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, type RenderResult, waitFor, waitForElementToBeRemoved } from "test-utils-rtl";
import { Room, type RoomMember, MatrixError, type IContent, type RoomSummary } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { withClientContextRenderOptions, stubClient } from "test-utils";

import { MatrixClientPeg } from "../../../MatrixClientPeg";
import DMRoomMap from "../../../utils/DMRoomMap";
import RoomPreviewBar from "./RoomPreviewBar";
import defaultDispatcher from "../../../dispatcher/dispatcher";
import { ModuleApi } from "../../../modules/Api.ts";

vi.mock("../../../IdentityAuthClient", () => {
    return {
        default: vi.fn().mockImplementation(function () {
            return { getAccessToken: vi.fn().mockResolvedValue("mock-token") };
        }),
    };
});

vi.useRealTimers();

const createRoom = (roomId: string, userId: string): Room => {
    const cli = MatrixClientPeg.safeGet();
    const newRoom = new Room(roomId, cli, userId, {});
    DMRoomMap.makeShared(cli).start();
    return newRoom;
};

const makeMockRoomMember = ({
    userId,
    isKicked,
    membership,
    content,
    memberContent,
    oldMembership,
}: {
    userId?: string;
    isKicked?: boolean;
    membership?: KnownMembership.Invite | KnownMembership.Ban | KnownMembership.Leave;
    content?: Partial<IContent>;
    memberContent?: Partial<IContent>;
    oldMembership?: KnownMembership.Join | KnownMembership.Knock;
}) =>
    ({
        userId,
        rawDisplayName: `${userId} name`,
        isKicked: vi.fn().mockReturnValue(!!isKicked),
        getContent: vi.fn().mockReturnValue(content || {}),
        getPrevContent: vi.fn().mockReturnValue(content || {}),
        membership,
        events: {
            member: {
                getSender: vi.fn().mockReturnValue("@kicker:test.com"),
                getContent: vi.fn().mockReturnValue({ reason: "test reason", ...memberContent }),
                getPrevContent: vi.fn().mockReturnValue({ membership: oldMembership, ...memberContent }),
            },
        },
    }) as unknown as RoomMember;

describe("<RoomPreviewBar />", () => {
    const roomId = "RoomPreviewBar-test-room";
    const userId = "@tester:test.com";
    const inviterUserId = "@inviter:test.com";
    const otherUserId = "@othertester:test.com";

    const getComponent = (props: ComponentProps<typeof RoomPreviewBar> = {}) => {
        const defaultProps = {
            roomId,
            room: createRoom(roomId, userId),
        };
        return render(
            <RoomPreviewBar {...defaultProps} {...props} />,
            withClientContextRenderOptions(MatrixClientPeg.safeGet()),
        );
    };

    const isSpinnerRendered = (wrapper: RenderResult) => !!wrapper.container.querySelector(".mx_Spinner");
    const getMessage = (wrapper: RenderResult) =>
        wrapper.container.querySelector<HTMLDivElement>(".mx_RoomPreviewBar_message");
    const getActions = (wrapper: RenderResult) =>
        wrapper.container.querySelector<HTMLDivElement>(".mx_RoomPreviewBar_actions");
    const getPrimaryActionButton = (wrapper: RenderResult) =>
        getActions(wrapper)?.querySelector(".mx_AccessibleButton_kind_primary");
    const getSecondaryActionButton = (wrapper: RenderResult) =>
        getActions(wrapper)?.querySelector(".mx_AccessibleButton_kind_secondary");

    beforeEach(() => {
        stubClient();
        MatrixClientPeg.get()!.getUserId = vi.fn().mockReturnValue(userId);
        MatrixClientPeg.get()!.getSafeUserId = vi.fn().mockReturnValue(userId);
        MatrixClientPeg.safeGet().getUserId = vi.fn().mockReturnValue(userId);
        MatrixClientPeg.safeGet().getSafeUserId = vi.fn().mockReturnValue(userId);
    });

    afterEach(() => {
        const container = document.body.firstChild;
        if (container) document.body.removeChild(container);
    });

    it("renders joining message", () => {
        const component = getComponent({ joining: true });

        expect(isSpinnerRendered(component)).toBeTruthy();
        expect(getMessage(component)?.textContent).toEqual("Joining…");
    });
    it("renders rejecting message", () => {
        const component = getComponent({ rejecting: true });
        expect(isSpinnerRendered(component)).toBeTruthy();
        expect(getMessage(component)?.textContent).toEqual("Rejecting invite…");
    });
    it("renders loading message", () => {
        const component = getComponent({ loading: true });
        expect(isSpinnerRendered(component)).toBeTruthy();
        expect(getMessage(component)?.textContent).toEqual("Loading…");
    });

    it("renders not logged in message", () => {
        MatrixClientPeg.safeGet().isGuest = vi.fn().mockReturnValue(true);
        const component = getComponent({ loading: true });

        expect(isSpinnerRendered(component)).toBeFalsy();
        expect(getMessage(component)?.textContent).toEqual("Join the conversation with an account");
    });

    it("should send room oob data to start login", async () => {
        MatrixClientPeg.safeGet().isGuest = vi.fn().mockReturnValue(true);
        const component = getComponent({
            oobData: {
                name: "Room Name",
                avatarUrl: "mxc://foo/bar",
                inviterName: "Charlie",
            },
        });

        const dispatcherSpy = vi.fn();
        const dispatcherRef = defaultDispatcher.register(dispatcherSpy);

        expect(getMessage(component)?.textContent).toEqual("Join the conversation with an account");
        fireEvent.click(getPrimaryActionButton(component)!);

        await waitFor(() =>
            expect(dispatcherSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    screenAfterLogin: {
                        screen: "room",
                        params: expect.objectContaining({
                            room_name: "Room Name",
                            room_avatar_url: "mxc://foo/bar",
                            inviter_name: "Charlie",
                        }),
                    },
                }),
            ),
        );

        defaultDispatcher.unregister(dispatcherRef);
    });

    it("renders kicked message", () => {
        const room = createRoom(roomId, otherUserId);
        vi.spyOn(room, "getMember").mockReturnValue(makeMockRoomMember({ isKicked: true }));
        const component = getComponent({ room, canAskToJoinAndMembershipIsLeave: true, promptAskToJoin: false });

        expect(getMessage(component)).toMatchSnapshot();
    });

    it("renders denied request message", () => {
        const room = createRoom(roomId, otherUserId);
        vi.spyOn(room, "getMember").mockReturnValue(
            makeMockRoomMember({
                isKicked: true,
                membership: KnownMembership.Leave,
                oldMembership: KnownMembership.Knock,
            }),
        );
        const component = getComponent({ room, promptAskToJoin: true });

        expect(getMessage(component)).toMatchSnapshot();
    });

    it("triggers the primary action callback for denied request", () => {
        const onForgetClick = vi.fn();
        const room = createRoom(roomId, otherUserId);
        vi.spyOn(room, "getMember").mockReturnValue(
            makeMockRoomMember({
                isKicked: true,
                membership: KnownMembership.Leave,
                oldMembership: KnownMembership.Knock,
            }),
        );
        const component = getComponent({ room, promptAskToJoin: true, onForgetClick });

        fireEvent.click(getPrimaryActionButton(component)!);
        expect(onForgetClick).toHaveBeenCalled();
    });

    it("renders banned message", () => {
        const room = createRoom(roomId, otherUserId);
        vi.spyOn(room, "getMember").mockReturnValue(makeMockRoomMember({ membership: KnownMembership.Ban }));
        const component = getComponent({ loading: true, room });

        expect(getMessage(component)).toMatchSnapshot();
    });

    describe("with an error", () => {
        it("renders room not found error", () => {
            const error = new MatrixError({
                errcode: "M_NOT_FOUND",
                error: "Room not found",
            });
            const component = getComponent({ error });

            expect(getMessage(component)).toMatchSnapshot();
        });
        it("renders other errors", () => {
            const error = new MatrixError({
                errcode: "Something_else",
            });
            const component = getComponent({ error });

            expect(getMessage(component)).toMatchSnapshot();
        });
    });

    it("renders viewing room message when room an be previewed", () => {
        const component = getComponent({ canPreview: true });

        expect(getMessage(component)).toMatchSnapshot();
    });

    it("renders viewing room message when room can not be previewed", () => {
        const component = getComponent({ canPreview: false });

        expect(getMessage(component)).toMatchSnapshot();
    });

    describe("with an invite", () => {
        const inviterName = inviterUserId;
        const userMember = makeMockRoomMember({ userId });
        const userMemberWithDmInvite = makeMockRoomMember({
            userId,
            membership: KnownMembership.Invite,
            memberContent: { is_direct: true, membership: KnownMembership.Invite },
        });
        const inviterMember = makeMockRoomMember({
            userId: inviterUserId,
            content: {
                "reason": "test",
                "io.element.html_reason": "<h3>hello</h3>",
            },
        });
        describe("without an invited email", () => {
            describe("for a non-dm room", () => {
                const mockGetMember = (id: string) => {
                    if (id === userId) return userMember;
                    return inviterMember;
                };
                const onJoinClick = vi.fn();
                const onRejectClick = vi.fn();
                let room: Room;

                beforeEach(() => {
                    room = createRoom(roomId, userId);
                    vi.spyOn(room, "getMember").mockImplementation(mockGetMember);
                    vi.spyOn(room.currentState, "getMember").mockImplementation(mockGetMember);
                    onJoinClick.mockClear();
                    onRejectClick.mockClear();
                });

                it("renders invite message", () => {
                    const component = getComponent({ inviterName, room });
                    expect(getMessage(component)).toMatchSnapshot();
                });

                it("renders join and reject action buttons correctly", () => {
                    const component = getComponent({ inviterName, room, onJoinClick, onDeclineClick: onRejectClick });
                    expect(getActions(component)).toMatchSnapshot();
                });

                it("renders join and reject action buttons in reverse order when room can previewed", () => {
                    // when room is previewed action buttons are rendered left to right, with primary on the right
                    const component = getComponent({
                        inviterName,
                        room,
                        onJoinClick,
                        onDeclineClick: onRejectClick,
                        canPreview: true,
                    });
                    expect(getActions(component)).toMatchSnapshot();
                });

                it("joins room on primary button click", () => {
                    const component = getComponent({ inviterName, room, onJoinClick, onDeclineClick: onRejectClick });
                    fireEvent.click(getPrimaryActionButton(component)!);

                    expect(onJoinClick).toHaveBeenCalled();
                });

                it("rejects invite on secondary button click", () => {
                    const component = getComponent({ inviterName, room, onJoinClick, onDeclineClick: onRejectClick });
                    fireEvent.click(getSecondaryActionButton(component)!);

                    expect(onRejectClick).toHaveBeenCalled();
                });
            });

            describe("for a dm room", () => {
                const mockGetMember = (id: string) => {
                    if (id === userId) return userMemberWithDmInvite;
                    return inviterMember;
                };
                const onJoinClick = vi.fn();
                const onRejectClick = vi.fn();
                let room: Room;

                beforeEach(() => {
                    room = createRoom(roomId, userId);
                    vi.spyOn(room, "getMember").mockImplementation(mockGetMember);
                    vi.spyOn(room.currentState, "getMember").mockImplementation(mockGetMember);
                    onJoinClick.mockClear();
                    onRejectClick.mockClear();
                });

                it("renders invite message", () => {
                    const component = getComponent({ inviterName, room });
                    expect(getMessage(component)).toMatchSnapshot();
                });
            });
        });

        describe("with an invited email", () => {
            const invitedEmail = "test@test.com";
            const mockThreePids = [
                { medium: "email", address: invitedEmail },
                { medium: "not-email", address: "address 2" },
            ];

            const testJoinButtonFactory =
                (props: ComponentProps<typeof RoomPreviewBar>, expectSecondaryButton = false) =>
                async () => {
                    const onJoinClick = vi.fn();
                    const onRejectClick = vi.fn();
                    const component = getComponent({ ...props, onJoinClick, onDeclineClick: onRejectClick });
                    await waitFor(() => expect(getPrimaryActionButton(component)).toBeTruthy());
                    if (expectSecondaryButton) expect(getSecondaryActionButton(component)).toBeFalsy();
                    fireEvent.click(getPrimaryActionButton(component)!);
                    expect(onJoinClick).toHaveBeenCalled();
                };

            describe("when client fails to get 3PIDs", () => {
                beforeEach(() => {
                    MatrixClientPeg.safeGet().getThreePids = vi.fn().mockRejectedValue({ errCode: "TEST_ERROR" });
                });

                it("renders error message", async () => {
                    const component = getComponent({ inviterName, invitedEmail });
                    await waitForElementToBeRemoved(() => component.queryByRole("progressbar"));

                    expect(getMessage(component)).toMatchSnapshot();
                });

                it("renders join button", testJoinButtonFactory({ inviterName, invitedEmail }));
            });

            describe("when invitedEmail is not associated with current account", () => {
                beforeEach(() => {
                    MatrixClientPeg.safeGet().getThreePids = vi
                        .fn()
                        .mockResolvedValue({ threepids: mockThreePids.slice(1) });
                });

                it("renders invite message with invited email", async () => {
                    const component = getComponent({ inviterName, invitedEmail });
                    await waitForElementToBeRemoved(() => component.queryByRole("progressbar"));

                    expect(getMessage(component)).toMatchSnapshot();
                });

                it("renders join button", testJoinButtonFactory({ inviterName, invitedEmail }));
            });

            describe("when client has no identity server connected", () => {
                beforeEach(() => {
                    MatrixClientPeg.safeGet().getThreePids = vi.fn().mockResolvedValue({ threepids: mockThreePids });
                    MatrixClientPeg.safeGet().getIdentityServerUrl = vi.fn().mockReturnValue(false);
                });

                it("renders invite message with invited email", async () => {
                    const component = getComponent({ inviterName, invitedEmail });
                    await waitForElementToBeRemoved(() => component.queryByRole("progressbar"));

                    expect(getMessage(component)).toMatchSnapshot();
                });

                it("renders join button", testJoinButtonFactory({ inviterName, invitedEmail }));
            });

            describe("when client has an identity server connected", () => {
                beforeEach(() => {
                    MatrixClientPeg.safeGet().getThreePids = vi.fn().mockResolvedValue({ threepids: mockThreePids });
                    MatrixClientPeg.safeGet().getIdentityServerUrl = vi.fn().mockReturnValue("identity.test");
                    MatrixClientPeg.safeGet().lookupThreePid = vi.fn().mockResolvedValue("identity.test");
                });

                it("renders email mismatch message when invite email mxid doesnt match", async () => {
                    MatrixClientPeg.safeGet().lookupThreePid = vi.fn().mockReturnValue({ mxid: "not userid" });
                    const component = getComponent({ inviterName, invitedEmail });
                    await waitForElementToBeRemoved(() => component.queryByRole("progressbar"));

                    expect(getMessage(component)).toMatchSnapshot();
                    expect(MatrixClientPeg.safeGet().lookupThreePid).toHaveBeenCalledWith(
                        "email",
                        invitedEmail,
                        "mock-token",
                    );
                    await testJoinButtonFactory({ inviterName, invitedEmail })();
                });

                it("renders email mismatch message when no email bound", async () => {
                    MatrixClientPeg.safeGet().lookupThreePid = vi.fn().mockReturnValue({});
                    const component = getComponent({ inviterName, invitedEmail });
                    await waitForElementToBeRemoved(() => component.queryByRole("progressbar"));

                    expect(getMessage(component)).toMatchSnapshot();
                    expect(MatrixClientPeg.safeGet().lookupThreePid).toHaveBeenCalledWith(
                        "email",
                        invitedEmail,
                        "mock-token",
                    );
                    await testJoinButtonFactory({ inviterName, invitedEmail })();
                });

                it("renders invite message when invite email mxid match", async () => {
                    MatrixClientPeg.safeGet().lookupThreePid = vi.fn().mockReturnValue({ mxid: userId });
                    const component = getComponent({ inviterName, invitedEmail });
                    await waitForElementToBeRemoved(() => component.queryByRole("progressbar"));

                    expect(getMessage(component)).toMatchSnapshot();
                    await testJoinButtonFactory({ inviterName, invitedEmail }, false)();
                });
            });
        });
    });

    describe("message case AskToJoin", () => {
        it("renders the corresponding message", () => {
            const component = getComponent({ promptAskToJoin: true });
            expect(getMessage(component)).toMatchSnapshot();
        });

        it("renders the corresponding message when kicked", () => {
            const room = createRoom(roomId, otherUserId);
            vi.spyOn(room, "getMember").mockReturnValue(makeMockRoomMember({ isKicked: true }));
            const component = getComponent({ room, promptAskToJoin: true });

            expect(getMessage(component)).toMatchSnapshot();
        });

        it("renders the corresponding message with a generic title", () => {
            const component = render(<RoomPreviewBar promptAskToJoin />);
            expect(getMessage(component)).toMatchSnapshot();
        });

        it("renders the corresponding actions", () => {
            const component = getComponent({ promptAskToJoin: true });
            expect(getActions(component)).toMatchSnapshot();
        });

        it("triggers the primary action callback", () => {
            const onSubmitAskToJoin = vi.fn();
            const component = getComponent({ promptAskToJoin: true, onSubmitAskToJoin });

            fireEvent.click(getPrimaryActionButton(component)!);
            expect(onSubmitAskToJoin).toHaveBeenCalled();
        });

        it("triggers the primary action callback with a reason", () => {
            const onSubmitAskToJoin = vi.fn();
            const reason = "some reason";
            const component = getComponent({ promptAskToJoin: true, onSubmitAskToJoin });

            fireEvent.change(component.container.querySelector("textarea")!, { target: { value: reason } });
            fireEvent.click(getPrimaryActionButton(component)!);

            expect(onSubmitAskToJoin).toHaveBeenCalledWith(reason);
        });

        it("caps the reason at 500 characters and counts what has been typed", () => {
            const component = getComponent({ promptAskToJoin: true });
            const counter = () => component.container.querySelector(".mx_RoomPreviewBar_reason_counter")?.textContent;

            const textarea = component.container.querySelector("textarea")!;
            expect(textarea.maxLength).toEqual(500);
            expect(counter()).toEqual("0/500");

            fireEvent.change(textarea, { target: { value: "let me in" } });
            expect(counter()).toEqual("9/500");
        });

        it("says a withdrawn request was cancelled, above the offer to ask again", () => {
            const component = getComponent({ promptAskToJoin: true, askToJoinCancelled: true });

            expect(getMessage(component)?.textContent).toContain("Request to join cancelled");
            expect(getPrimaryActionButton(component)?.textContent).toEqual("Request access");
        });
    });

    describe("message case Knocked", () => {
        it("renders the corresponding message", () => {
            const component = getComponent({ knocked: true });
            expect(getMessage(component)).toMatchSnapshot();
        });

        it("renders the corresponding actions", () => {
            const component = getComponent({ knocked: true, onCancelAskToJoin: () => {} });
            expect(getActions(component)).toMatchSnapshot();
        });

        it("triggers the secondary action callback", () => {
            const onCancelAskToJoin = vi.fn();
            const component = getComponent({ knocked: true, onCancelAskToJoin });

            fireEvent.click(getSecondaryActionButton(component)!);
            expect(onCancelAskToJoin).toHaveBeenCalled();
        });
    });

    describe("with a preview CTA", () => {
        const makeSummary = (extra: Partial<RoomSummary> = {}): RoomSummary => ({
            room_id: roomId,
            num_joined_members: 10,
            world_readable: false,
            guest_can_join: false,
            name: "Coffee break",
            topic: "Where we drink coffee",
            canonical_alias: "#coffeebreak:test.com",
            avatar_url: "mxc://test.com/coffee",
            ...extra,
        });

        const getIdentity = (wrapper: RenderResult) =>
            wrapper.container.querySelector<HTMLDivElement>(".mx_RoomPreviewBar_identity");

        const namedSpace = (name: string) => {
            const space = createRoom("!space:test.com", userId);
            vi.spyOn(space, "name", "get").mockReturnValue(name);
            vi.spyOn(MatrixClientPeg.safeGet(), "getRoom").mockReturnValue(space);
        };

        it("names the room, its alias, its member count and its topic", () => {
            const component = getComponent({ summary: makeSummary(), previewCta: { kind: "join", allowedVia: [] } });

            const identity = getIdentity(component);
            expect(identity?.textContent).toContain("Coffee break");
            expect(identity?.textContent).toContain("#coffeebreak:test.com");
            expect(identity?.textContent).toContain("10");
            expect(identity?.textContent).toContain("Where we drink coffee");
            expect(getPrimaryActionButton(component)?.textContent).toEqual("Join room");
        });

        it("says which room a restricted join is allowed by", () => {
            namedSpace("Design");
            const component = getComponent({
                summary: makeSummary(),
                previewCta: { kind: "join", allowedVia: ["!space:test.com"] },
            });

            expect(getMessage(component)?.textContent).toContain("You can join because you are a member of Design");
        });

        it("names the room whose members may join one the user is not allowed into", () => {
            namedSpace("Design");
            const component = getComponent({
                summary: makeSummary(),
                previewCta: { kind: "notAllowed", allowedVia: ["!space:test.com"] },
            });

            expect(getMessage(component)?.textContent).toEqual("Members of Design can join.");
            expect(getPrimaryActionButton(component)).toBeFalsy();
        });

        it("falls back to generic copy when the allowing room is unknown", () => {
            vi.spyOn(MatrixClientPeg.safeGet(), "getRoom").mockReturnValue(null);
            const component = getComponent({
                summary: makeSummary(),
                previewCta: { kind: "notAllowed", allowedVia: ["!unknown:test.com"] },
            });

            expect(getMessage(component)?.textContent).toEqual(
                "You may need to be invited or be a member of a space in order to join.",
            );
        });

        it("names the room a request is pending on, and offers to cancel it", () => {
            const component = getComponent({
                summary: makeSummary(),
                previewCta: { kind: "waiting", allowedVia: [] },
                onCancelAskToJoin: () => {},
            });

            expect(getIdentity(component)?.textContent).toContain("Coffee break");
            expect(getMessage(component)?.textContent).toContain("Request to join sent");
            expect(getMessage(component)?.textContent).toContain(
                "You will receive an invite to join the room if your request is accepted.",
            );
            expect(getSecondaryActionButton(component)?.textContent).toEqual("Cancel request");
        });

        it("names the room a request was denied on, and offers to forget it", () => {
            const component = getComponent({
                summary: makeSummary(),
                previewCta: { kind: "denied", allowedVia: [] },
                onForgetClick: () => {},
            });

            expect(getIdentity(component)?.textContent).toContain("Coffee break");
            expect(getMessage(component)?.textContent).toContain("You have been denied access");
            expect(getPrimaryActionButton(component)?.textContent).toEqual("Forget this room");
        });

        it("shows a banned room by name only, and offers to forget it", () => {
            const component = getComponent({
                summary: makeSummary(),
                previewCta: { kind: "banned", allowedVia: [] },
                onForgetClick: () => {},
            });

            const identity = getIdentity(component);
            expect(identity?.textContent).toContain("Coffee break");
            expect(identity?.textContent).not.toContain("Where we drink coffee");
            expect(identity?.textContent).not.toContain("10");
            expect(getMessage(component)?.textContent).toContain("You were banned from this room");
            expect(getPrimaryActionButton(component)?.textContent).toEqual("Forget this room");
        });

        it("keeps the room's identity while saying an invite is needed", () => {
            const component = getComponent({
                summary: makeSummary(),
                previewCta: { kind: "needInvite", allowedVia: [] },
            });

            expect(getIdentity(component)?.textContent).toContain("Where we drink coffee");
            expect(getMessage(component)?.textContent).toEqual("You need an invite in order to join this room.");
            expect(getPrimaryActionButton(component)).toBeFalsy();
        });

        it("does not show a card in the panel under a peeked timeline", () => {
            const component = getComponent({
                summary: makeSummary(),
                previewCta: { kind: "join", allowedVia: [] },
                canPreview: true,
            });

            expect(getIdentity(component)).toBeFalsy();
            expect(getMessage(component)?.textContent).toEqual("You're previewing Coffee break. Want to join it?");
        });
    });

    describe("with a summary error", () => {
        it("says a room which was not found may need an invite", () => {
            const component = getComponent({ summaryError: "notFound" });

            expect(getMessage(component)?.textContent).toContain("Room not found");
            expect(getMessage(component)?.textContent).toContain(
                "This room may not exist, or you may need an invite to see it.",
            );
        });

        it("says a room the server will not describe needs an invite from someone in it", () => {
            const component = getComponent({ summaryError: "forbidden" });

            expect(getMessage(component)?.textContent).toContain("You do not have access to this room");
            expect(getMessage(component)?.textContent).toContain("Ask someone in the room to invite you.");
        });

        it("still offers a join when the summary is merely unavailable", () => {
            const component = getComponent({ summaryError: "unavailable", onJoinClick: () => {} });

            expect(getMessage(component)?.textContent).not.toContain("Room not found");
            expect(getPrimaryActionButton(component)?.textContent).toEqual("Join room");
        });
    });

    it("should render Module roomPreviewBarRenderer if specified", () => {
        vi.spyOn(ModuleApi.instance.customComponents, "roomPreviewBarRenderer", "get").mockReturnValue(() => (
            <>Test component</>
        ));
        const { getByText } = render(<RoomPreviewBar />);
        expect(getByText("Test component")).toBeTruthy();
    });
});
