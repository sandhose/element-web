/*
Copyright 2024 New Vector Ltd.
Copyright 2017-2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import {
    EventType,
    JoinRule,
    KnownMembership,
    MatrixError,
    Room,
    type RoomMember,
    RoomType,
    type RoomSummary,
    SyncState,
} from "matrix-js-sdk/src/matrix";
import { sleep } from "matrix-js-sdk/src/utils";
import {
    RoomViewLifecycle,
    type ViewRoomOpts,
} from "@matrix-org/react-sdk-module-api/lib/lifecycles/RoomViewLifecycle";
import EventEmitter from "node:events";
import type * as NodeEvents from "node:events";
import { vi, describe, it, expect, beforeEach, afterEach, type MockedClass } from "vitest";
import {
    flushPromises,
    getMockClientWithEventEmitter,
    mkEvent,
    mkRoom,
    mkRoomMember,
    mockStateEventImplementation,
    setupAsyncStoreWithClient,
    untilDispatch,
    untilEmission,
    TestSDKContext,
} from "test-utils";

import { RoomViewStore } from "./RoomViewStore";
import { Action } from "../dispatcher/actions";
import SettingsStore from "../settings/SettingsStore";
import { SlidingSyncManager } from "../SlidingSyncManager";
import { PosthogAnalytics } from "../PosthogAnalytics";
import { TimelineRenderingType } from "../contexts/RoomContext";
import { MatrixDispatcher } from "../dispatcher/dispatcher";
import { UPDATE_EVENT } from "./AsyncStore";
import { type ActiveRoomChangedPayload } from "../dispatcher/payloads/ActiveRoomChangedPayload";
import SpaceStore from "./spaces/SpaceStore";
import { type ViewRoomPayload } from "../dispatcher/payloads/ViewRoomPayload";
import Modal from "../Modal";
import ErrorDialog from "../components/views/dialogs/ErrorDialog";
import { type CancelAskToJoinPayload } from "../dispatcher/payloads/CancelAskToJoinPayload";
import { type JoinRoomErrorPayload } from "../dispatcher/payloads/JoinRoomErrorPayload";
import { type SubmitAskToJoinPayload } from "../dispatcher/payloads/SubmitAskToJoinPayload";
import { ModuleRunner } from "../modules/ModuleRunner";
import { type IApp } from "../utils/WidgetUtils-types";
import { CallStore } from "./CallStore";
import { MatrixClientPeg } from "../MatrixClientPeg";
import MediaDeviceHandler, { MediaDeviceKindEnum } from "../MediaDeviceHandler";
import { storeRoomAliasInCache } from "../RoomAliasCache.ts";
import { type Call, ConnectionState, ElementCall } from "../models/Call.ts";
import ActiveWidgetStore from "./ActiveWidgetStore";
import { ModuleApi } from "../modules/Api";
import { type JoinRoomPayload } from "../dispatcher/payloads/JoinRoomPayload.ts";
import { RoomPreviewStore } from "./RoomPreviewStore";
import { PreviewMode } from "../utils/room/previewMode";
import { SettingLevel } from "../settings/SettingLevel";

vi.mock("../Modal");

// mock out the injected classes
vi.mock("../PosthogAnalytics");
const MockPosthogAnalytics = PosthogAnalytics as unknown as MockedClass<typeof PosthogAnalytics>;
vi.mock("../SlidingSyncManager");
const MockSlidingSyncManager = SlidingSyncManager as unknown as MockedClass<typeof SlidingSyncManager>;
vi.mock("./spaces/SpaceStore");
const MockSpaceStore = SpaceStore as unknown as MockedClass<typeof SpaceStore>;

// mock VoiceRecording because it contains all the audio APIs
vi.mock("../audio/VoiceRecording", () => ({
    VoiceRecording: vi.fn().mockReturnValue({
        disableMaxLength: vi.fn(),
        liveData: {
            onUpdate: vi.fn(),
        },
        off: vi.fn(),
        on: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        destroy: vi.fn(),
        contentType: "audio/ogg",
    }),
}));

vi.spyOn(MediaDeviceHandler, "getDevices").mockResolvedValue({
    [MediaDeviceKindEnum.AudioInput]: [],
    [MediaDeviceKindEnum.VideoInput]: [],
    [MediaDeviceKindEnum.AudioOutput]: [],
});

vi.mock("../utils/DMRoomMap", () => {
    const mock = {
        getUserIdForRoomId: vi.fn(),
        getDMRoomsForUserId: vi.fn(),
    };

    return {
        default: {
            shared: vi.fn().mockReturnValue(mock),
            sharedInstance: mock,
        },
    };
});

vi.mock("./WidgetStore", async () => {
    const { EventEmitter } = await vi.importActual<typeof NodeEvents>("node:events");
    const apps: IApp[] = [];
    const instance = new (class extends EventEmitter {
        getApps() {
            return apps;
        }
        addVirtualWidget(app: IApp) {
            apps.push(app);
        }
    })();
    return { default: { instance } };
});
vi.mock("./widgets/WidgetLayoutStore");

describe("RoomViewStore", function () {
    const userId = "@alice:server";
    const roomId = "!randomcharacters:aser.ver";
    const roomId2 = "!room2:example.com";
    // we need to change the alias to ensure cache misses as the cache exists
    // through all tests.
    let alias = "#somealias2:aser.ver";
    const getRooms = vi.fn();
    const mockClient = getMockClientWithEventEmitter({
        joinRoom: vi.fn(),
        getRoom: vi.fn(),
        getRoomIdForAlias: vi.fn(),
        getRooms,
        isGuest: vi.fn(),
        getUserId: vi.fn().mockReturnValue(userId),
        getSafeUserId: vi.fn().mockReturnValue(userId),
        getDeviceId: vi.fn().mockReturnValue("ABC123"),
        getDomain: vi.fn().mockReturnValue("server"),
        sendStateEvent: vi.fn().mockResolvedValue({}),
        supportsThreads: vi.fn(),
        isInitialSyncComplete: vi.fn().mockResolvedValue(false),
        relations: vi.fn(),
        knockRoom: vi.fn(),
        forget: vi.fn(),
        getRoomSummary: vi.fn(),
        hydrateRoomFromSummary: vi.fn(),
        leave: vi.fn(),
        setRoomAccountData: vi.fn(),
        getAccountData: vi.fn(),
        waitForClientWellKnown: vi.fn().mockResolvedValue(undefined),
        getClientWellKnown: vi.fn().mockReturnValue({}),
        cachedRtcTransports: {
            get: vi.fn().mockReturnValue([]),
            wait: vi.fn().mockResolvedValue([]),
        },
        matrixRTC: new (class extends EventEmitter {
            getRoomSession() {
                return new (class extends EventEmitter {
                    memberships = [];
                })();
            }
        })(),
    });
    const room = mkRoom(mockClient, roomId);
    const room2 = new Room(roomId2, mockClient, userId);
    getRooms.mockReturnValue([room, room2]);

    const dispatchPromptAskToJoin = async () => {
        dis.dispatch({ action: Action.PromptAskToJoin });
        await untilDispatch(Action.PromptAskToJoin, dis);
    };

    const dispatchSubmitAskToJoin = async (roomId: string, reason?: string) => {
        dis.dispatch<SubmitAskToJoinPayload>({ action: Action.SubmitAskToJoin, roomId, opts: { reason } });
        await untilDispatch(Action.SubmitAskToJoin, dis);
    };

    const dispatchCancelAskToJoin = async (roomId: string) => {
        dis.dispatch<CancelAskToJoinPayload>({ action: Action.CancelAskToJoin, roomId });
        await untilDispatch(Action.CancelAskToJoin, dis);
    };

    const dispatchRoomLoaded = async () => {
        dis.dispatch({ action: Action.RoomLoaded });
        await untilDispatch(Action.RoomLoaded, dis);
    };

    let roomViewStore: RoomViewStore;
    let slidingSyncManager: SlidingSyncManager;
    let dis: MatrixDispatcher;
    let stores: TestSDKContext;

    beforeEach(async function () {
        vi.clearAllMocks();
        mockClient.credentials = { userId: userId };
        mockClient.joinRoom.mockResolvedValue(room);
        mockClient.getRoom.mockImplementation((roomId?: string): Room | null => {
            if (roomId === room.roomId) return room;
            if (roomId === room2.roomId) return room2;
            return null;
        });
        mockClient.isGuest.mockReturnValue(false);
        mockClient.getSafeUserId.mockReturnValue(userId);

        // Make the RVS to test
        dis = new MatrixDispatcher();
        slidingSyncManager = new MockSlidingSyncManager();
        stores = new TestSDKContext();
        stores._client = mockClient;
        stores._SlidingSyncManager = slidingSyncManager;
        stores._PosthogAnalytics = new MockPosthogAnalytics(
            undefined as unknown as ConstructorParameters<typeof PosthogAnalytics>[0],
        );
        vi.spyOn(MockPosthogAnalytics, "instance", "get").mockReturnValue(stores._PosthogAnalytics);
        stores._SpaceStore = new MockSpaceStore(
            undefined as unknown as ConstructorParameters<typeof SpaceStore>[0],
            undefined as unknown as ConstructorParameters<typeof SpaceStore>[1],
        );
        // Add activeSpace property to the mock
        Object.defineProperty(stores._SpaceStore, "activeSpace", {
            value: null,
            writable: true,
            configurable: true,
        });
        stores._RoomPreviewStore = new RoomPreviewStore(dis);
        await setupAsyncStoreWithClient(stores._RoomPreviewStore, mockClient);
        roomViewStore = new RoomViewStore(dis, stores);
        stores._RoomViewStore = roomViewStore;
    });

    it("can be used to view a room by ID and join", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        dis.dispatch({ action: Action.JoinRoom });
        await untilDispatch(Action.JoinRoomReady, dis);
        expect(mockClient.joinRoom).toHaveBeenCalledWith(roomId, { acceptSharedHistory: true, viaServers: [] });
        expect(roomViewStore.isJoining()).toBe(true);
    });

    it("can be used to view a room by alias with auto_join", async () => {
        const alias = "#alias12345:server";
        storeRoomAliasInCache(alias, roomId, ["server1"]);
        dis.dispatch({ action: Action.ViewRoom, room_alias: alias, auto_join: true }, true);
        await expect(untilDispatch(Action.ViewRoom, dis)).resolves.toEqual(
            expect.objectContaining({
                action: Action.ViewRoom,
                room_id: roomId,
                auto_join: true,
            }),
        );
        await untilDispatch(Action.JoinRoomReady, dis);
        expect(mockClient.joinRoom).toHaveBeenCalledWith(alias, { acceptSharedHistory: true, viaServers: ["server1"] });
        expect(roomViewStore.isJoining()).toBe(true);
    });

    it("can auto-join a room", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId, auto_join: true });
        await untilDispatch(Action.JoinRoomReady, dis);
        expect(mockClient.joinRoom).toHaveBeenCalledWith(roomId, { acceptSharedHistory: true, viaServers: [] });
        expect(roomViewStore.isJoining()).toBe(true);
    });

    it("emits ActiveRoomChanged when the viewed room changes", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        let payload = (await untilDispatch(Action.ActiveRoomChanged, dis)) as ActiveRoomChangedPayload;
        expect(payload.newRoomId).toEqual(roomId);
        expect(payload.oldRoomId).toEqual(null);

        dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 });
        payload = (await untilDispatch(Action.ActiveRoomChanged, dis)) as ActiveRoomChangedPayload;
        expect(payload.newRoomId).toEqual(roomId2);
        expect(payload.oldRoomId).toEqual(roomId);
    });

    it("invokes room activity listeners when the viewed room changes", async () => {
        const callback = vi.fn();
        roomViewStore.addRoomListener(roomId, callback);
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        (await untilDispatch(Action.ActiveRoomChanged, dis)) as ActiveRoomChangedPayload;
        expect(callback).toHaveBeenCalledWith(true);
        expect(callback).not.toHaveBeenCalledWith(false);

        dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 });
        (await untilDispatch(Action.ActiveRoomChanged, dis)) as ActiveRoomChangedPayload;
        expect(callback).toHaveBeenCalledWith(false);
    });

    it("can be used to view a room by alias and join", async () => {
        mockClient.getRoomIdForAlias.mockResolvedValue({ room_id: roomId, servers: [] });
        dis.dispatch({ action: Action.ViewRoom, room_alias: alias });
        await untilDispatch((p) => {
            // wait for the re-dispatch with the room ID
            return p.action === Action.ViewRoom && p.room_id === roomId;
        }, dis);

        // roomId is set to id of the room alias
        expect(roomViewStore.getRoomId()).toBe(roomId);

        // join the room
        dis.dispatch({ action: Action.JoinRoom }, true);

        await untilDispatch(Action.JoinRoomReady, dis);

        expect(roomViewStore.isJoining()).toBeTruthy();
        expect(mockClient.joinRoom).toHaveBeenCalledWith(alias, { acceptSharedHistory: true, viaServers: [] });
    });

    it("emits ViewRoomError if the alias lookup fails", async () => {
        alias = "#something-different:to-ensure-cache-miss";
        mockClient.getRoomIdForAlias.mockRejectedValue(new Error("network error or something"));
        dis.dispatch({ action: Action.ViewRoom, room_alias: alias });
        const payload = await untilDispatch(Action.ViewRoomError, dis);
        expect(payload.room_id).toBeNull();
        expect(payload.room_alias).toEqual(alias);
        expect(roomViewStore.getRoomAlias()).toEqual(alias);
    });

    it("emits JoinRoomError if joining the room fails", async () => {
        const joinErr = new Error("network error or something");
        mockClient.joinRoom.mockRejectedValue(joinErr);
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        dis.dispatch({ action: Action.JoinRoom });
        await untilDispatch(Action.JoinRoomError, dis);
        expect(roomViewStore.isJoining()).toBe(false);
        expect(roomViewStore.getJoinError()).toEqual(joinErr);
    });

    it("remembers the event being replied to when swapping rooms", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        const replyToEvent = {
            getRoomId: () => roomId,
        };
        dis.dispatch({ action: "reply_to_event", event: replyToEvent, context: TimelineRenderingType.Room });
        await untilEmission(roomViewStore, UPDATE_EVENT);
        expect(roomViewStore.getQuotingEvent()).toEqual(replyToEvent);
        // view the same room, should remember the event.
        // set the highlighed flag to make sure there is a state change so we get an update event
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId, highlighted: true });
        await untilEmission(roomViewStore, UPDATE_EVENT);
        expect(roomViewStore.getQuotingEvent()).toEqual(replyToEvent);
    });

    it("swaps to the replied event room if it is not the current room", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        const replyToEvent = {
            getRoomId: () => roomId2,
        };
        dis.dispatch({ action: "reply_to_event", event: replyToEvent, context: TimelineRenderingType.Room });
        await untilDispatch(Action.ViewRoom, dis);
        expect(roomViewStore.getQuotingEvent()).toEqual(replyToEvent);
        expect(roomViewStore.getRoomId()).toEqual(roomId2);
    });

    it("should ignore reply_to_event for Thread panels", async () => {
        expect(roomViewStore.getQuotingEvent()).toBeFalsy();
        const replyToEvent = {
            getRoomId: () => roomId2,
        };
        dis.dispatch({ action: "reply_to_event", event: replyToEvent, context: TimelineRenderingType.Thread });
        await sleep(100);
        expect(roomViewStore.getQuotingEvent()).toBeFalsy();
    });

    it.each([TimelineRenderingType.Room, TimelineRenderingType.File, TimelineRenderingType.Notification])(
        "Should respect reply_to_event for %s rendering context",
        async (context) => {
            const replyToEvent = {
                getRoomId: () => roomId,
            };
            dis.dispatch({ action: "reply_to_event", event: replyToEvent, context });
            await untilDispatch(Action.ViewRoom, dis);
            expect(roomViewStore.getQuotingEvent()).toEqual(replyToEvent);
        },
    );

    it("does not change room when replying to event in a room displayed in module", async () => {
        // Spy on dispatch to check later if ViewRoom was dispatched
        vi.spyOn(dis, "dispatch");

        // Set up current room
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        expect(roomViewStore.getRoomId()).toEqual(roomId);

        ModuleApi.instance.extras.getVisibleRoomBySpaceKey("space1", () => [roomId, roomId2]);
        // @ts-ignore
        stores.spaceStore.activeSpace = "space1";

        // Create reply event for roomId2 (which is displayed in module)
        const replyToEvent = {
            getRoomId: () => roomId2,
        };

        // Dispatch reply_to_event - should not change room since roomId2 is in module
        dis.dispatch({ action: "reply_to_event", event: replyToEvent, context: TimelineRenderingType.Room });
        await flushPromises();

        // Room should remain the same (roomId), not change to roomId2
        expect(dis.dispatch).not.toHaveBeenCalledWith({
            action: Action.ViewRoom,
            room_id: roomId2,
            replyingToEvent: replyToEvent,
            metricsTrigger: undefined,
        });
    });

    it("removes the roomId on ViewHomePage", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        expect(roomViewStore.getRoomId()).toEqual(roomId);

        dis.dispatch({ action: Action.ViewHomePage });
        await untilEmission(roomViewStore, UPDATE_EVENT);
        expect(roomViewStore.getRoomId()).toBeNull();
    });

    it("when viewing a call without a broadcast, it should not raise an error", async () => {
        const call = { presented: false } as Call;
        const getCallSpy = vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
        await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());

        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            view_call: true,
            metricsTrigger: undefined,
        });
        await untilDispatch(Action.ViewRoom, dis);

        expect(getCallSpy).toHaveBeenCalledWith(roomId);
        expect(call.presented).toEqual(true);
    });

    it("implicitly views an active call", async () => {
        const call = { presented: false } as Call;
        vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
        vi.spyOn(CallStore.instance, "getActiveCall").mockImplementation((rId) => (rId === roomId ? call : null));
        await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());

        // View the room without explicitly setting view_call to true
        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            metricsTrigger: undefined,
        });
        await untilDispatch(Action.ViewRoom, dis);

        expect(call.presented).toEqual(true);
    });

    it("opens a voice-intent call directly in picture-in-picture rather than maximised", async () => {
        const call = {
            presented: false,
            connectionState: ConnectionState.Disconnected,
            widget: { id: "!widget:example.org" },
            start: vi.fn(),
        } as unknown as Call;
        vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
        const persistenceSpy = vi.spyOn(ActiveWidgetStore.instance, "setWidgetPersistence");
        await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());

        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            view_call: true,
            voiceOnly: true,
            metricsTrigger: undefined,
        });
        await untilDispatch(Action.ViewRoom, dis);

        // The call is started and marked persistent so it renders in the PiP container...
        expect(call.presented).toEqual(true);
        expect(persistenceSpy).toHaveBeenCalledWith("!widget:example.org", roomId, true);
        expect(call.start).toHaveBeenCalledWith(expect.objectContaining({ voiceOnly: true }));
        // ...but the room is not switched to the maximised call view.
        expect(roomViewStore.isViewingCall()).toEqual(false);
    });

    it("opens a video-intent call maximised in the room", async () => {
        const call = {
            presented: false,
            connectionState: ConnectionState.Disconnected,
            widget: { id: "!widget:example.org" },
            start: vi.fn(),
        } as unknown as Call;
        vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
        const persistenceSpy = vi.spyOn(ActiveWidgetStore.instance, "setWidgetPersistence");
        await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());

        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            view_call: true,
            voiceOnly: false,
            metricsTrigger: undefined,
        });
        await untilDispatch(Action.ViewRoom, dis);

        expect(call.presented).toEqual(true);
        expect(persistenceSpy).not.toHaveBeenCalled();
        expect(call.start).toHaveBeenCalledWith(expect.objectContaining({ voiceOnly: false }));
        expect(roomViewStore.isViewingCall()).toEqual(true);
    });

    it("should display an error message when the room is unreachable via the roomId", async () => {
        // View and wait for the room
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        // Generate error to display the expected error message
        const error = new MatrixError(undefined, 404);
        roomViewStore.showJoinRoomError(error, roomId);

        // Check the modal props
        expect(vi.mocked(Modal).createDialog.mock.calls[0][1]).toMatchSnapshot();
    });
    // The server bob is on will affect the message we send.
    it.each(["server", "another-server"])(
        "should display an invite-specific error message when the room is unreachable",
        async (bobsServer) => {
            room.getMyMembership.mockReturnValue(KnownMembership.Invite);
            room.getMember.mockImplementationOnce((memberUserId) => {
                if (userId === memberUserId) {
                    const member = mkRoomMember(roomId, userId, KnownMembership.Invite);
                    member.events.member!.getSender = () => `@bob:${bobsServer}`;
                    return member;
                }
                return null;
            });
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);

            // Generate error to display the expected error message
            const error = new MatrixError(undefined, 404);
            roomViewStore.showJoinRoomError(error, roomId);

            // Check the modal props
            expect(vi.mocked(Modal).createDialog.mock.calls[0][1]).toMatchSnapshot();
        },
    );

    it("should display an error message when the provided room is invalid", async () => {
        dis.dispatch({ action: Action.JoinRoom, room_id: "" });
        const result = await untilDispatch(Action.JoinRoomError, dis);
        expect(result.err.cause.message).toEqual("Cannot join room: no room ID or alias to join");
    });

    it("should display the generic error message when the roomId doesnt match", async () => {
        // When
        // Generate error to display the expected error message
        const error = new MatrixError({ error: "my 404 error" }, 404);
        roomViewStore.showJoinRoomError(error, roomId);

        // Check the modal props
        expect(vi.mocked(Modal).createDialog.mock.calls[0][1]).toMatchSnapshot();
    });

    it("clears the unread flag when viewing a room", async () => {
        room.getAccountData.mockReturnValue(
            mkEvent({ type: "m.marked_unread", user: "@anyone:example.org", content: { unread: true }, event: true }),
        );
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        expect(mockClient.setRoomAccountData).toHaveBeenCalledWith(roomId, "m.marked_unread", {
            unread: false,
        });
    });

    describe("Sliding Sync", function () {
        beforeEach(() => {
            vi.spyOn(SettingsStore, "getValue").mockImplementation((settingName, roomId, value) => {
                return settingName === "feature_simplified_sliding_sync"; // this is enabled, everything else is disabled.
            });
        });

        afterEach(() => {
            // Restore immediately: this mock makes RoomViewStore.viewRoom() take the "simplified sliding sync"
            // branch, which re-dispatches Action.ViewRoom asynchronously. If left in place after this describe
            // block, it leaks into later tests (vi.clearAllMocks() clears call history but not implementations)
            // and can cause a dangling re-dispatch that fires during a later test and crashes on
            // MatrixClientPeg.safeGet() once that room is no longer set up.
            vi.mocked(SettingsStore.getValue).mockRestore();
        });

        it("subscribes to the room", async () => {
            const setRoomVisible = vi.spyOn(slidingSyncManager, "setRoomVisible").mockReturnValue(Promise.resolve());
            const subscribedRoomId = "!sub1:localhost";
            dis.dispatch({ action: Action.ViewRoom, room_id: subscribedRoomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(roomViewStore.getRoomId()).toBe(subscribedRoomId);
            expect(setRoomVisible).toHaveBeenCalledWith(subscribedRoomId);
        });

        // Previously a regression test for an in-the-wild bug where rooms would rapidly switch forever in sliding sync mode
        // although that was before the complexity was removed with similified mode. I've removed the complexity but kept the
        // test anyway.
        it("doesn't get stuck in a loop if you view rooms quickly", async () => {
            const setRoomVisible = vi.spyOn(slidingSyncManager, "setRoomVisible").mockReturnValue(Promise.resolve());
            const subscribedRoomId = "!sub1:localhost";
            const subscribedRoomId2 = "!sub2:localhost";
            dis.dispatch({ action: Action.ViewRoom, room_id: subscribedRoomId }, true);
            dis.dispatch({ action: Action.ViewRoom, room_id: subscribedRoomId2 }, true);
            await untilDispatch(Action.ActiveRoomChanged, dis);
            // should view 1, then 2
            const wantCalls = [[subscribedRoomId], [subscribedRoomId2]];
            expect(setRoomVisible).toHaveBeenCalledTimes(wantCalls.length);
            wantCalls.forEach((v, i) => {
                try {
                    expect(setRoomVisible.mock.calls[i][0]).toEqual(v[0]);
                } catch {
                    throw new Error(`i=${i} got ${setRoomVisible.mock.calls[i]} want ${v}`);
                }
            });
        });
    });

    describe("Action.JoinRoom", () => {
        it("dispatches Action.JoinRoomError and Action.AskToJoin when the join fails with 403", async () => {
            const err = new MatrixError({}, 403);

            vi.spyOn(dis, "dispatch");
            vi.spyOn(mockClient, "joinRoom").mockRejectedValueOnce(err);

            const roomId = "!hello:world";

            dis.dispatch<JoinRoomPayload>({
                action: Action.JoinRoom,
                canAskToJoin: true,
                roomId,
                metricsTrigger: "RoomPreview",
            });
            await untilDispatch(Action.PromptAskToJoin, dis);

            expect(vi.mocked(dis.dispatch).mock.calls[0][0]).toEqual({
                action: Action.JoinRoom,
                canAskToJoin: true,
                metricsTrigger: "RoomPreview",
                roomId,
            });
            expect(vi.mocked(dis.dispatch).mock.calls[1][0]).toEqual({
                action: Action.JoinRoomError,
                roomId,
                err,
                canAskToJoin: true,
            });
            expect(vi.mocked(dis.dispatch).mock.calls[2][0]).toEqual({ action: Action.PromptAskToJoin });
        });

        it("sets 'acceptSharedHistory'", async () => {
            dis.dispatch<ViewRoomPayload>({ action: Action.ViewRoom, room_id: roomId, metricsTrigger: "RoomList" });
            dis.dispatch<JoinRoomPayload>({ action: Action.JoinRoom, roomId: roomId, metricsTrigger: "RoomPreview" });
            await untilDispatch(Action.JoinRoomReady, dis);
            expect(mockClient.joinRoom).toHaveBeenCalledWith(roomId, { acceptSharedHistory: true, viaServers: [] });
        });
    });

    describe("Action.JoinRoomError", () => {
        const err = new MatrixError();
        beforeEach(() => vi.spyOn(roomViewStore, "showJoinRoomError"));

        it("calls showJoinRoomError()", async () => {
            dis.dispatch<JoinRoomErrorPayload>({ action: Action.JoinRoomError, roomId, err });
            await untilDispatch(Action.JoinRoomError, dis);
            expect(roomViewStore.showJoinRoomError).toHaveBeenCalledWith(err, roomId);
        });

        it("does not call showJoinRoomError() when canAskToJoin is true", async () => {
            dis.dispatch<JoinRoomErrorPayload>({ action: Action.JoinRoomError, roomId, err, canAskToJoin: true });
            await untilDispatch(Action.JoinRoomError, dis);
            expect(roomViewStore.showJoinRoomError).not.toHaveBeenCalled();
        });
    });

    describe("askToJoin()", () => {
        it("returns false", () => {
            expect(roomViewStore.promptAskToJoin()).toBe(false);
        });

        it("returns true", async () => {
            await dispatchPromptAskToJoin();
            expect(roomViewStore.promptAskToJoin()).toBe(true);
        });
    });

    describe("Action.SubmitAskToJoin", () => {
        const reason = "some reason";
        beforeEach(async () => await dispatchPromptAskToJoin());

        it("calls knockRoom() and sets promptAskToJoin state to false", async () => {
            vi.spyOn(mockClient, "knockRoom").mockResolvedValue({ room_id: roomId });
            await dispatchSubmitAskToJoin(roomId, reason);

            expect(mockClient.knockRoom).toHaveBeenCalledWith(roomId, { reason, viaServers: [] });
            expect(roomViewStore.promptAskToJoin()).toBe(false);
        });

        it("calls knockRoom(), sets promptAskToJoin state to false and shows an error dialog", async () => {
            const error = new MatrixError(undefined, 403);
            vi.spyOn(mockClient, "knockRoom").mockRejectedValue(error);
            await dispatchSubmitAskToJoin(roomId, reason);

            expect(mockClient.knockRoom).toHaveBeenCalledWith(roomId, { reason, viaServers: [] });
            expect(roomViewStore.promptAskToJoin()).toBe(false);
            expect(Modal.createDialog).toHaveBeenCalledWith(ErrorDialog, {
                description: "You need an invite to access this room.",
                title: "Failed to join",
            });
        });

        it("shows an error dialog with a generic error message", async () => {
            const error = new MatrixError();
            vi.spyOn(mockClient, "knockRoom").mockRejectedValue(error);
            await dispatchSubmitAskToJoin(roomId);

            expect(Modal.createDialog).toHaveBeenCalledWith(ErrorDialog, {
                description: error.message,
                title: "Failed to join",
            });
        });
    });

    describe("Action.CancelAskToJoin", () => {
        const answerConfirmation = (confirmed: boolean) =>
            vi.mocked(Modal).createDialog.mockReturnValue({
                finished: Promise.resolve([confirmed]),
                close: vi.fn(),
            } as unknown as ReturnType<typeof Modal.createDialog>);

        beforeEach(async () => {
            vi.spyOn(mockClient, "knockRoom").mockResolvedValue({ room_id: roomId });
            vi.spyOn(mockClient, "leave").mockResolvedValue({});
            mockClient.forget.mockResolvedValue({});
            await dispatchSubmitAskToJoin(roomId);
        });

        it("asks for confirmation before withdrawing the request", async () => {
            answerConfirmation(false);
            await dispatchCancelAskToJoin(roomId);
            await flushPromises();

            expect(vi.mocked(Modal).createDialog.mock.calls[0][1]).toEqual(
                expect.objectContaining({ title: "Cancel request to join" }),
            );
            expect(mockClient.leave).not.toHaveBeenCalled();
        });

        it("leaves and forgets the room once the user confirms", async () => {
            answerConfirmation(true);
            await dispatchCancelAskToJoin(roomId);
            await flushPromises();

            expect(mockClient.leave).toHaveBeenCalledWith(roomId);
            expect(mockClient.forget).toHaveBeenCalledWith(roomId);
        });

        it("reports the cancellation so the bar can offer to ask again", async () => {
            answerConfirmation(true);
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(roomViewStore.hasCancelledAskToJoin()).toBe(false);

            await dispatchCancelAskToJoin(roomId);
            await flushPromises();

            expect(roomViewStore.hasCancelledAskToJoin()).toBe(true);
        });

        it("shows an error dialog when leaving fails", async () => {
            answerConfirmation(true);
            const error = new MatrixError();
            vi.spyOn(mockClient, "leave").mockRejectedValue(error);
            await dispatchCancelAskToJoin(roomId);
            await flushPromises();

            expect(mockClient.forget).not.toHaveBeenCalled();
            expect(Modal.createDialog).toHaveBeenCalledWith(ErrorDialog, {
                description: error.message,
                title: "Failed to cancel",
            });
        });
    });

    describe("room summary", () => {
        // A room the user is a member of needs no summary, so preview a room they are not in.
        const roomId3 = "!room3:example.com";
        let room3: Room;

        const summaryFor = (id: string, name: string): RoomSummary =>
            ({
                room_id: id,
                name,
                world_readable: false,
                guest_can_join: false,
                num_joined_members: 3,
            }) as RoomSummary;

        beforeEach(() => {
            room3 = new Room(roomId3, mockClient, userId);
            mockClient.getRoom.mockImplementation((id?: string): Room | null => {
                if (id === room.roomId) return room;
                if (id === room2.roomId) return room2;
                if (id === roomId3) return room3;
                return null;
            });
        });

        it("mirrors the preview of the room being viewed", async () => {
            const summary = summaryFor(roomId2, "A previewable room");
            let resolveSummary: (summary: RoomSummary) => void;
            mockClient.getRoomSummary.mockImplementation(
                () => new Promise<RoomSummary>((resolve) => (resolveSummary = resolve)),
            );

            dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(roomViewStore.getRoomSummary()).toBeNull();

            resolveSummary!(summary);
            await flushPromises();
            expect(roomViewStore.getRoomSummary()).toEqual(summary);
            expect(roomViewStore.getSummaryError()).toBeNull();
        });

        it("exposes why a room has no summary", async () => {
            mockClient.getRoomSummary.mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403));

            dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            await flushPromises();

            expect(roomViewStore.getRoomSummary()).toBeNull();
            expect(roomViewStore.getSummaryError()).toBe("forbidden");
        });

        it("has no summary for a room the user is joined to", async () => {
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            await flushPromises();

            expect(mockClient.getRoomSummary).not.toHaveBeenCalled();
            expect(roomViewStore.getRoomSummary()).toBeNull();
        });

        it("does not expose the summary of a room which is no longer being viewed", async () => {
            let resolveFirst: (summary: RoomSummary) => void;
            mockClient.getRoomSummary.mockImplementationOnce(
                () => new Promise<RoomSummary>((resolve) => (resolveFirst = resolve)),
            );
            mockClient.getRoomSummary.mockResolvedValue(summaryFor(roomId3, "The other room"));

            dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId3 });
            await untilDispatch(Action.ActiveRoomChanged, dis);

            resolveFirst!(summaryFor(roomId2, "A previewable room"));
            await flushPromises();

            expect(roomViewStore.getRoomId()).toBe(roomId3);
            expect(roomViewStore.getRoomSummary()?.name).toBe("The other room");
        });

        it("re-requests the summary with the via servers the room was reached through", async () => {
            mockClient.getRoomSummary.mockResolvedValue(summaryFor(roomId2, "A previewable room"));

            dis.dispatch({ action: Action.ViewRoom, room_id: roomId2, via_servers: ["server.example"] });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            await flushPromises();
            expect(mockClient.getRoomSummary).toHaveBeenCalledWith(roomId2, ["server.example"]);

            // A second view of the room on screen carries no via servers of its own.
            stores.roomPreviewStore.release(roomId2);
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 });
            await flushPromises();

            expect(mockClient.getRoomSummary).toHaveBeenCalledTimes(2);
            expect(mockClient.getRoomSummary).toHaveBeenLastCalledWith(roomId2, ["server.example"]);
        });

        it("clears the summary when leaving the room", async () => {
            mockClient.getRoomSummary.mockResolvedValue(summaryFor(roomId2, "A previewable room"));

            dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            await flushPromises();
            expect(roomViewStore.getRoomSummary()).not.toBeNull();

            dis.dispatch({ action: Action.ViewHomePage });
            await untilDispatch(Action.ViewHomePage, dis);
            expect(roomViewStore.getRoomSummary()).toBeNull();
        });
    });

    describe("auto-join on an approved knock", () => {
        const knockRoomId = "!approved:example.com";
        let approved: ReturnType<typeof mkRoom>;

        const membershipChanged = async (room: Room) => {
            dis.dispatch({ action: "MatrixActions.Room.myMembership", room });
            await untilDispatch("MatrixActions.Room.myMembership", dis);
            await flushPromises();
        };

        const previousMembership = (membership: string) =>
            approved.getMember.mockReturnValue({
                events: { member: { getPrevContent: () => ({ membership }) } },
            } as unknown as RoomMember);

        beforeEach(() => {
            approved = mkRoom(mockClient, knockRoomId);
            approved.getMyMembership.mockReturnValue(KnownMembership.Invite);
            previousMembership(KnownMembership.Knock);
            getRooms.mockReturnValue([room, room2, approved]);
            mockClient.getRoom.mockImplementation((id?: string): Room | null => {
                if (id === knockRoomId) return approved;
                if (id === room.roomId) return room;
                if (id === room2.roomId) return room2;
                return null;
            });
            vi.spyOn(SettingsStore, "getValue").mockImplementation(
                (settingName) => settingName === "feature_ask_to_join",
            );
        });

        afterEach(() => {
            getRooms.mockReturnValue([room, room2]);
            if (vi.isMockFunction(SettingsStore.getValue)) vi.mocked(SettingsStore.getValue).mockRestore();
        });

        it("joins a room whose invite replaced a knock", async () => {
            await membershipChanged(approved);
            expect(mockClient.joinRoom).toHaveBeenCalledWith(knockRoomId, { viaServers: [] });
        });

        it("joins such a room only once", async () => {
            await membershipChanged(approved);
            await membershipChanged(approved);
            expect(mockClient.joinRoom).toHaveBeenCalledTimes(1);
        });

        it("leaves a plain invite for the user to accept", async () => {
            previousMembership(KnownMembership.Leave);
            await membershipChanged(approved);
            expect(mockClient.joinRoom).not.toHaveBeenCalled();
        });

        it("does nothing for a room the user is already in", async () => {
            approved.getMyMembership.mockReturnValue(KnownMembership.Join);
            await membershipChanged(approved);
            expect(mockClient.joinRoom).not.toHaveBeenCalled();
        });

        it("does nothing while asking to join is disabled", async () => {
            vi.mocked(SettingsStore.getValue).mockReturnValue(false);
            await membershipChanged(approved);
            expect(mockClient.joinRoom).not.toHaveBeenCalled();
        });

        it("joins a room approved before the view, which sees no transition", async () => {
            dis.dispatch({ action: Action.ViewRoom, room_id: knockRoomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            await flushPromises();

            expect(mockClient.joinRoom).toHaveBeenCalledWith(knockRoomId, { viaServers: [] });
        });

        it("retries on the next trigger when the join is refused", async () => {
            mockClient.joinRoom.mockRejectedValueOnce(new MatrixError());
            dis.dispatch({ action: Action.ViewRoom, room_id: knockRoomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            await flushPromises();

            dis.dispatch({ action: "MatrixActions.sync", state: SyncState.Prepared });
            await untilDispatch("MatrixActions.sync", dis);
            await flushPromises();

            expect(mockClient.joinRoom).toHaveBeenCalledTimes(2);
        });
    });

    describe("preview mode", () => {
        const knockableRoom = () => {
            room.getMyMembership.mockReturnValue(KnownMembership.Leave);
            room.getJoinRule.mockReturnValue(JoinRule.Knock);
        };
        const askToJoin = (enabled: boolean) =>
            vi.spyOn(SettingsStore, "getValue").mockImplementation((settingName) => {
                if (settingName === "feature_ask_to_join") return enabled;
                return false;
            });

        afterEach(() => {
            // The mocks outlive `vi.clearAllMocks()`, which only clears call history, and `room`
            // is shared by the whole suite.
            if (vi.isMockFunction(SettingsStore.getValue)) vi.mocked(SettingsStore.getValue).mockRestore();
            vi.mocked(room.currentState).getStateEvents.mockImplementation(mockStateEventImplementation([]));
            room.getMember.mockReset();
        });

        it("waits before any room is viewed", () => {
            expect(roomViewStore.getPreviewMode()).toEqual(PreviewMode.Loading);
        });

        it("renders the room itself for a room the user is in", async () => {
            room.getMyMembership.mockReturnValue(KnownMembership.Join);
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(roomViewStore.getPreviewMode()).toEqual(PreviewMode.Full);
        });

        it("offers the ask for a knockable room the user is not in", async () => {
            askToJoin(true);
            knockableRoom();
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(roomViewStore.getPreviewMode()).toEqual(PreviewMode.Bar);
            expect(roomViewStore.getPreviewCta()).toEqual({ kind: "ask", allowedVia: [] });
        });

        it("recomputes when the ask-to-join flag is toggled", async () => {
            askToJoin(true);
            knockableRoom();
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);

            askToJoin(false);
            dis.dispatch({
                action: Action.SettingUpdated,
                settingName: "feature_ask_to_join",
                roomId: null,
                level: SettingLevel.DEVICE,
                newValueAtLevel: false,
                newValue: false,
            });
            await untilEmission(roomViewStore, UPDATE_EVENT);
            expect(roomViewStore.getPreviewCta().kind).toEqual("needInvite");
        });

        it("recomputes when the user's own membership changes", async () => {
            askToJoin(true);
            knockableRoom();
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(roomViewStore.getPreviewCta().kind).toEqual("ask");

            room.getMyMembership.mockReturnValue(KnownMembership.Knock);
            dis.dispatch({ action: "MatrixActions.Room.myMembership", room });
            await untilEmission(roomViewStore, UPDATE_EVENT);
            expect(roomViewStore.getPreviewCta().kind).toEqual("waiting");
        });

        it("recomputes when the join rules change", async () => {
            askToJoin(true);
            room.getMyMembership.mockReturnValue(KnownMembership.Leave);
            room.getJoinRule.mockReturnValue(JoinRule.Invite);
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(roomViewStore.getPreviewCta().kind).toEqual("needInvite");

            room.getJoinRule.mockReturnValue(JoinRule.Public);
            dis.dispatch({
                action: "MatrixActions.RoomState.events",
                event: mkEvent({
                    event: true,
                    type: EventType.RoomJoinRules,
                    room: roomId,
                    user: userId,
                    skey: "",
                    content: { join_rule: JoinRule.Public },
                }),
                state: { roomId },
                lastStateEvent: null,
            });
            await untilEmission(roomViewStore, UPDATE_EVENT);
            expect(roomViewStore.getPreviewCta().kind).toEqual("join");
        });

        it("reports a refused knock the membership never moved for", async () => {
            askToJoin(true);
            knockableRoom();
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(roomViewStore.getPreviewCta().kind).toEqual("ask");

            // The knock never reached the client, so the kick which refuses it leaves the
            // membership at the leave it already was.
            const kick = mkEvent({
                event: true,
                type: EventType.RoomMember,
                room: roomId,
                user: "@bob:server",
                skey: userId,
                content: { membership: KnownMembership.Leave },
                prev_content: { membership: KnownMembership.Knock },
            });
            vi.mocked(room.currentState).getStateEvents.mockImplementation(mockStateEventImplementation([kick]));
            room.getMember.mockReturnValue(
                mkRoomMember(roomId, userId, KnownMembership.Leave, true, { membership: KnownMembership.Knock }),
            );
            dis.dispatch({
                action: "MatrixActions.RoomState.events",
                event: kick,
                state: { roomId },
                lastStateEvent: null,
            });
            await untilEmission(roomViewStore, UPDATE_EVENT);

            expect(roomViewStore.getPreviewCta().kind).toEqual("denied");
        });

        it("ignores a room other than the one being viewed", async () => {
            askToJoin(true);
            knockableRoom();
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);

            room.getMyMembership.mockReturnValue(KnownMembership.Knock);
            dis.dispatch({ action: "MatrixActions.Room.myMembership", room: room2 });
            await flushPromises();
            expect(roomViewStore.getPreviewCta().kind).toEqual("ask");
        });
    });

    describe("getViewRoomOpts", () => {
        it("returns viewRoomOpts", () => {
            expect(roomViewStore.getViewRoomOpts()).toEqual({ buttons: [] });
        });
    });

    describe("call view", () => {
        const callRoomId = "!callroom:server";
        let callRoom: ReturnType<typeof mkRoom>;
        let call: Call;
        let created: boolean;
        let arrived: boolean;

        beforeEach(async () => {
            created = false;
            arrived = true;
            // A server which will not describe the room: this suite is about the call, not the summary.
            mockClient.getRoomSummary.mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403));
            callRoom = mkRoom(mockClient, callRoomId);
            callRoom.isCallRoom.mockReturnValue(true);
            callRoom.getType.mockReturnValue(RoomType.UnstableCall);
            callRoom.getMyMembership.mockReturnValue(KnownMembership.Join);
            mockClient.getRoom.mockImplementation((id?: string): Room | null => {
                if (id === room.roomId) return room;
                if (id === room2.roomId) return room2;
                if (id === callRoomId && arrived) return callRoom;
                return null;
            });

            call = {
                presented: false,
                connectionState: ConnectionState.Disconnected,
                widget: { id: "!widget:server" },
                start: vi.fn(),
                destroy: vi.fn(),
            } as unknown as Call;
            vi.spyOn(ElementCall, "create").mockImplementation(() => {
                created = true;
            });
            vi.spyOn(CallStore.instance, "getCall").mockImplementation((id) =>
                id === callRoomId && created ? call : null,
            );
            vi.spyOn(CallStore.instance, "getActiveCall").mockReturnValue(null);
            vi.spyOn(CallStore.instance, "getConfiguredRTCTransports").mockReturnValue([
                { type: "livekit" },
            ] as unknown as ReturnType<CallStore["getConfiguredRTCTransports"]>);
            await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());
        });

        afterEach(() => {
            if (vi.isMockFunction(SettingsStore.getValue)) vi.mocked(SettingsStore.getValue).mockRestore();
            mockClient.getRoomSummary.mockReset();
        });

        const enableVideoRooms = () =>
            vi
                .spyOn(SettingsStore, "getValue")
                .mockImplementation((settingName) =>
                    ["feature_video_rooms", "feature_element_call_video_rooms", "feature_ask_to_join"].includes(
                        settingName,
                    ),
                );

        it("boots the call of a room which only arrives after it was viewed", async () => {
            arrived = false;
            dis.dispatch({ action: Action.ViewRoom, room_id: callRoomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(ElementCall.create).not.toHaveBeenCalled();
            expect(roomViewStore.isViewingCall()).toBe(false);

            arrived = true;
            dis.dispatch({ action: "MatrixActions.Room", room: callRoom });
            await untilEmission(roomViewStore, UPDATE_EVENT);

            expect(roomViewStore.isViewingCall()).toBe(true);
            expect(CallStore.instance.getCall(callRoomId)).toBe(call);
            expect(call.presented).toBe(true);
            expect(call.start).toHaveBeenCalled();
        });

        it("boots the call of a knockable call room the user is not in", async () => {
            enableVideoRooms();
            callRoom.getMyMembership.mockReturnValue(KnownMembership.Leave);
            callRoom.getJoinRule.mockReturnValue(JoinRule.Knock);

            dis.dispatch({ action: Action.ViewRoom, room_id: callRoomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);

            expect(roomViewStore.getPreviewMode()).toEqual(PreviewMode.Lobby);
            expect(ElementCall.create).toHaveBeenCalledWith(callRoom);
            expect(call.presented).toBe(true);
        });

        it("boots nothing for a call room the user cannot enter", async () => {
            enableVideoRooms();
            callRoom.getMyMembership.mockReturnValue(KnownMembership.Leave);
            callRoom.getJoinRule.mockReturnValue(JoinRule.Invite);

            dis.dispatch({ action: Action.ViewRoom, room_id: callRoomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);

            expect(roomViewStore.getPreviewMode()).toEqual(PreviewMode.Bar);
            expect(ElementCall.create).not.toHaveBeenCalled();
        });

        it("gives up and destroys the call of a preview room when navigating away", async () => {
            enableVideoRooms();
            callRoom.getMyMembership.mockReturnValue(KnownMembership.Leave);
            callRoom.getJoinRule.mockReturnValue(JoinRule.Knock);
            vi.spyOn(stores.roomPreviewStore, "isPreviewRoom").mockImplementation((id) => id === callRoomId);

            dis.dispatch({ action: Action.ViewRoom, room_id: callRoomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(call.presented).toBe(true);

            dis.dispatch({ action: Action.ViewHomePage });
            await untilEmission(roomViewStore, UPDATE_EVENT);

            expect(call.presented).toBe(false);
            expect(call.destroy).toHaveBeenCalled();
        });

        it("keeps the call of a room which stays in the store when navigating away", async () => {
            vi.spyOn(stores.roomPreviewStore, "isPreviewRoom").mockReturnValue(false);

            dis.dispatch({ action: Action.ViewRoom, room_id: callRoomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(call.presented).toBe(true);

            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);

            expect(call.presented).toBe(false);
            expect(call.destroy).not.toHaveBeenCalled();
        });
    });

    describe("Action.RoomLoaded", () => {
        it("updates viewRoomOpts", async () => {
            const buttons: ViewRoomOpts["buttons"] = [
                {
                    icon: "test-icon",
                    id: "test-id",
                    label: () => "test-label",
                    onClick: () => {},
                },
            ];
            vi.spyOn(ModuleRunner.instance, "invoke").mockImplementation((lifecycleEvent, opts) => {
                if (lifecycleEvent === RoomViewLifecycle.ViewRoom) {
                    opts.buttons = buttons;
                }
            });
            await dispatchRoomLoaded();
            expect(roomViewStore.getViewRoomOpts()).toEqual({ buttons });
        });
    });
});
