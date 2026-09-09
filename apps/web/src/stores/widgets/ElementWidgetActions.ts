/*
 * Copyright 2024 New Vector Ltd.
 * Copyright 2020-2022 The Matrix.org Foundation C.I.C.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { type IWidgetApiRequest } from "matrix-widget-api";

export enum ElementWidgetActions {
    // All of these actions are currently specific to Jitsi and Element Call
    JoinCall = "io.element.join",
    HangupCall = "im.vector.hangup",
    Close = "io.element.close",
    CallParticipants = "io.element.participants",
    StartLiveStream = "im.vector.start_live_stream",

    // Actions for switching layouts
    TileLayout = "io.element.tile_layout",
    SpotlightLayout = "io.element.spotlight_layout",

    /**
     * Asks the host to change the user's membership of the room the widget is in, replying with the
     * membership the room has afterwards, or with a widget API error.
     */
    Membership = "io.element.membership",

    OpenIntegrationManager = "integration_manager_open",
    /**
     * @deprecated Use MSC2931 instead
     */
    ViewRoom = "io.element.view_room",

    // This action type is used as a `fromWidget` and a `toWidget` action.
    // fromWidget: updates the client about the current device mute state
    // toWidget: the client requests a specific device mute configuration
    //   The reply will always be the resulting configuration
    //   It is possible to sent an empty configuration to retrieve the current values or
    //   just one of the fields to update that particular value
    //   An undefined field means that EC will keep the mute state as is.
    //   -> this will allow the client to only get the current state
    //
    // The data of the widget action request and the response are:
    // {
    //   audio_enabled?: boolean,
    //   video_enabled?: boolean
    // }
    // NOTE: this is currently unused. Its only here to make EW aware
    // of this action so it does not throw errors.
    DeviceMute = "io.element.device_mute",
}

export interface IHangupCallApiRequest extends IWidgetApiRequest {
    data: {
        errorMessage?: string;
    };
}

/** The membership operations {@link ElementWidgetActions.Membership} can be asked to perform. */
type MembershipAction = "join" | "knock" | "cancel_knock";

export interface IMembershipApiRequest extends IWidgetApiRequest {
    data: {
        action?: MembershipAction;
        /** The message shown to whoever decides on a knock. */
        reason?: string;
    };
}

/**
 * @deprecated Use MSC2931 instead
 */
export interface IViewRoomApiRequest extends IWidgetApiRequest {
    data: {
        room_id: string;
    };
}
