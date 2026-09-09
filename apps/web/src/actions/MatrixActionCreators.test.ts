/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { ClientEvent, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubClient } from "test-utils";

import MatrixActionCreators from "./MatrixActionCreators";
import dis from "../dispatcher/dispatcher";

describe("MatrixActionCreators", () => {
    const roomId = "!room:server";
    let client: MatrixClient;

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(dis, "dispatch");
        MatrixActionCreators.start(client);
    });

    afterEach(() => {
        MatrixActionCreators.stop();
    });

    it("dispatches MatrixActions.DeleteRoom when a room is removed", () => {
        client.emit(ClientEvent.DeleteRoom, roomId);

        expect(dis.dispatch).toHaveBeenCalledWith({ action: "MatrixActions.DeleteRoom", roomId }, false);
    });
});
