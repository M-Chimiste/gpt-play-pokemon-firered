const fs = require('fs').promises;
const path = require('path');
const { z } = require('zod');
const { zodToJsonSchema } = require('zod-to-json-schema');
const { config } = require('../config');
const { state, setIsThinking } = require('../state/stateManager');
const { broadcast } = require('../core/socketHub');
const { sendCommandsToPythonServer, requestConsoleRestart, fetchGameData } = require('../services/pythonService');
const { recordPathfindingUsage } = require('../utils/tokenUsageTracker');
const { recordReasoning: recordReasoningTime, recordToolBatch } = require('../utils/timeTracker');
const { findLocalPath } = require('../utils/pathfinding/localPathfinder');

function trunc(text, maxLen = 120) {
    if (text == null) return "";
    const s = String(text);
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 1) + "…";
}

function xmlEscape(text) {
    return String(text ?? "");
        // .replaceAll("&", "&amp;")
        // .replaceAll("<", "&lt;")
        // .replaceAll(">", "&gt;")
        // .replaceAll("\"", "&quot;")
        // .replaceAll("'", "&apos;");
}

function xmlAttr(value) {
    return xmlEscape(value).replaceAll("\n", " ").trim();
}

const ALLOWED_KEYPRESS_KEYS = [
    "up",
    "down",
    "left",
    "right",
    "a",
    "b",
    "start",
    "select",
    "a_until_end_of_dialog",
    "face_up",
    "face_down",
    "face_left",
    "face_right",
];

const AVATAR_EMOTIONS = [
    "default",
    "sad",
    "angry",
    "surprised",
    "confused",
    "excited",
    "bored",
    "fierce",
    "cry",
    "happy",
    "scared",
    "disappointed",
    "embarrassed",
    "hurt",
    "thinking",
    "wink",
    "kawai",
    "disgusted",
    "annoyed",
    "confident",
    "nervous",
    "shocked",
    "curious",
    "sleepy",
    "loving",
    "sick",
    "playful",
    "guilty",
    "proud",
    "suspicious",
    "overwhelmed",
    "frustrated",
    "relieved",
    "super_saiyen",
    "nostalgic",
    "smug",
    "tired",
    "mischievous",
    "reading",
    "throwing_pokeball",
    "reading_minimap",
    "cosplay_prof_oak",
    "cosplay_mewtwo",
    "cosplay_pikachu",
    "cosplay_gyarados",
    "cosplay_magikarp",
    "cosplay_missingno",
    "cosplay_zubat",
    "cosplay_blastoise",
    "cosplay_geodude",
    "cosplay_abra",
    "cosplay_pidgeotto",
    "cosplay_pidgeot",
    "cosplay_pidgey",
    "cosplay_team_rocket_member",
    "cosplay_nurse_joy",
    "cosplay_bulbasaur",
    "cosplay_ivysaur",
    "cosplay_venusaur",
    "cosplay_charizard",
    "cosplay_charmeleon",
    "cosplay_charmander",
    "cosplay_snorlax",
    "cosplay_lapras",
];

async function resolveMapBounds(gameDataJson, mapId) {
    if (typeof mapId !== "string" || !mapId.trim()) return null;

    const minimapData = gameDataJson?.minimap_data;
    if (minimapData && minimapData.map_id === mapId) {
        const width = Number(minimapData.width);
        const height = Number(minimapData.height);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            return { width, height, source: "minimap_data" };
        }
    }

    // Fallback: fog-of-war minimap cache files live at repo root `minimaps/<map_id>.json`
    const minimapsPath = path.join(config.paths.baseDir, "..", "minimaps", `${mapId}.json`);
    try {
        const raw = await fs.readFile(minimapsPath, "utf8");
        const grid = JSON.parse(raw);
        if (Array.isArray(grid) && grid.length > 0 && Array.isArray(grid[0])) {
            const height = grid.length;
            const width = grid[0].length;
            if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
                return { width, height, source: "minimaps_file" };
            }
        }
    } catch (error) {
        // ignore (missing file or invalid JSON)
    }

    return null;
}

function mapIdFromTraceState(st) {
    const g = st?.map?.group;
    const n = st?.map?.number;
    if (typeof g !== "number" || typeof n !== "number") return null;
    return `${g}-${n}`;
}

function mapKeyFromTraceState(st) {
    const mapId = mapIdFromTraceState(st);
    const mapName = st?.map?.name;
    if (!mapId && !mapName) return null;
    return `${mapId || ""}|${mapName || ""}`;
}

function formatMapLabel(mapId, mapName) {
    const id = typeof mapId === "string" ? mapId.trim() : "";
    const name = typeof mapName === "string" ? mapName.trim() : "";
    if (id && name) return `${id} — ${name}`;
    return id || name || "unknown";
}

function traceStateMarkdownLines(st, { includeMap = true } = {}) {
    const lines = [];

    const mapId = mapIdFromTraceState(st);
    const mapName = st?.map?.name;
    if (includeMap && (mapId || mapName)) {
        if (mapId && mapName) lines.push(`- Map: ${mapId} — ${mapName}`);
        else if (mapId) lines.push(`- Map: ${mapId}`);
        else lines.push(`- Map: ${mapName}`);
    }

    const pos = st?.player?.position;
    const x = Array.isArray(pos) && pos.length > 0 ? pos[0] : null;
    const y = Array.isArray(pos) && pos.length > 1 ? pos[1] : null;
    const facing = st?.player?.facing;
    const elevation = st?.player?.elevation;
    if (x != null && y != null) {
        const extras = [];
        if (facing) extras.push(`facing ${facing}`);
        if (typeof elevation === "number" && Number.isFinite(elevation)) extras.push(`elevation ${elevation}`);
        const extraText = extras.length ? `, ${extras.join(", ")}` : "";
        lines.push(`- Position: (${x},${y})${extraText}`);
    }

    const inDialog = !!st?.dialog?.inDialog;
    if (inDialog) {
        const menuType = st?.dialog?.menuType || "dialog";
        const text = st?.dialog?.visibleText;
        lines.push(`- Dialog (${menuType}): ${String(text ?? "")}`);
    }

    return lines;
}

function cmdLabelFromStep(step) {
    const t = step?.type ?? "?";
    const c = step?.command || {};
    if (t === "control") return String(c.command || "");
    if (t === "hold") return `hold:${c.button || "?"}:${c.frames || "?"}`;
    if (t === "press") return `press:${(c.buttons || []).join("+")}`;
    if (t === "controlStatus") return "controlStatus";
    return t;
}

function remainingCommandsFromPayload(payload) {
    const rem = Array.isArray(payload?.remaining_keys) ? payload.remaining_keys : [];
    return rem.map((c) => {
        if (c?.type === "control") return c.command;
        if (c?.type === "hold") return `hold:${c.button || "?"}:${c.frames || "?"}`;
        if (c?.type === "press") return `press:${(c.buttons || []).join("+")}`;
        return c?.type || "?";
    });
}

function summarizeTracePayloadMarkdown(payload) {
    if (!payload) {
        return "No payload";
    }

    const results = Array.isArray(payload.results) ? payload.results : [];
    const remaining = remainingCommandsFromPayload(payload);
    const interrupted = payload.interruptedByDialog === true;
    const interruptedByCollision = payload.interruptedByCollision === true;
    const collisionStreak = typeof payload.collisionStreak === "number" ? payload.collisionStreak : null;
    const startedInDialog = payload.startedInDialog === true;
    const interruptedAtIndex = typeof payload.interruptedAtIndex === "number" ? payload.interruptedAtIndex : null;
    const ok = payload.ok === true;
    const status = payload.status === true;

    const lines = [];
    lines.push(`Run:`);
    lines.push(`- ok: ${ok ? "true" : "false"}`);
    lines.push(`- status: ${status ? "true" : "false"}`);
    lines.push(`- startedInDialog: ${startedInDialog ? "true" : "false"}`);
    lines.push(`- interruptedByDialog: ${interrupted ? "true" : "false"}`);
    if (interruptedAtIndex != null) {
        lines.push(`- interruptedAtIndex: ${interruptedAtIndex}`);
    }
    lines.push(`- interruptedByCollision: ${interruptedByCollision ? "true" : "false"}`);
    if (collisionStreak != null) {
        lines.push(`- collisionStreak: ${collisionStreak}`);
    }

    const notes = [];
    if (interrupted) {
        notes.push("Dialog detected while executing commands, stopping sequence");
    }
    if (interruptedByCollision) {
        notes.push(
            `WARNING: Command sequence interrupted due to ${collisionStreak != null ? collisionStreak : 5} collisions in a row`
        );
    }

    if (remaining.length) {
        lines.push(`- remainingCommands: ${JSON.stringify(remaining)}`);
    }

    if (notes.length) {
        lines.push("");
        lines.push("Notes:");
        for (const note of notes) {
            lines.push(`- ${note}`);
        }
    }

    let lastMapKey = null;
    for (let i = 0; i < results.length; i++) {
        const step = results[i];
        const stepIndex = i + 1;
        const btn = cmdLabelFromStep(step);
        const okAttrVal = step?.ok === true ? "true" : "false";
        const msAttrVal = typeof step?.ms === "number" ? String(step.ms) : "";
        const typeAttrVal = step?.type ?? "?";

        lines.push("");
        lines.push(
            `### Step ${stepIndex} — ${btn}${typeAttrVal || okAttrVal || msAttrVal ? ` (type=${typeAttrVal}, ok=${okAttrVal}${msAttrVal ? `, ms=${msAttrVal}` : ""})` : ""}`
        );

        const beforeState = step?.before || {};
        const afterState = step?.after || {};
        const beforeMapKey = mapKeyFromTraceState(beforeState);
        const afterMapKey = mapKeyFromTraceState(afterState);
        const includeMapBefore = beforeMapKey != null && (lastMapKey == null || beforeMapKey !== lastMapKey);
        const includeMapAfter = afterMapKey != null && afterMapKey !== beforeMapKey;

        lines.push("");
        lines.push("Before:");
        const beforeLines = traceStateMarkdownLines(beforeState, { includeMap: includeMapBefore });
        lines.push(...(beforeLines.length ? beforeLines : ["- (no data)"]));

        lines.push("");
        lines.push("After:");
        const afterLines = traceStateMarkdownLines(afterState, { includeMap: includeMapAfter });
        lines.push(...(afterLines.length ? afterLines : ["- (no data)"]));

        // Custom trace payloads (ex: a_until_end_of_dialog transcript)
        const trace = step?.trace;
        const transcript = Array.isArray(trace?.transcript) ? trace.transcript : [];
        const evts = Array.isArray(trace?.events) ? trace.events : [];
        const stopReason = trace?.stopReason;
        const presses = typeof trace?.pressCount === "number" ? trace.pressCount : null;
        const autoPresses = typeof trace?.autoPressCount === "number" ? trace.autoPressCount : null;
        const dur = typeof trace?.durationMs === "number" ? trace.durationMs : null;
        const timedOut = trace?.timedOut === true;
        const maxPressesHit = trace?.maxPressesHit === true;

        if (stopReason || presses != null || autoPresses != null || dur != null || timedOut || maxPressesHit) {
            lines.push("");
            lines.push("Trace:");
            if (stopReason) lines.push(`- stopReason: ${String(stopReason)}`);
            if (presses != null) lines.push(`- pressCount: ${presses}`);
            if (autoPresses != null) lines.push(`- autoPressCount: ${autoPresses}`);
            if (dur != null) lines.push(`- durationMs: ${dur}`);
            if (timedOut) lines.push(`- timedOut: true`);
            if (maxPressesHit) lines.push(`- maxPressesHit: true`);
        }

        const groundWallChanged = trace?.groundWallChanged;
        const rawWallsToFree = Array.isArray(groundWallChanged?.wallsToFree) ? groundWallChanged.wallsToFree : [];
        const wallsToFree = rawWallsToFree
            .map((p) => {
                if (!Array.isArray(p) || p.length < 2) return null;
                const x = Number(p[0]);
                const y = Number(p[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                return [Math.trunc(x), Math.trunc(y)];
            })
            .filter((p) => Array.isArray(p) && p.length === 2);

        const rawFreeToWalls = Array.isArray(groundWallChanged?.freeToWalls) ? groundWallChanged.freeToWalls : [];
        const freeToWalls = rawFreeToWalls
            .map((p) => {
                if (!Array.isArray(p) || p.length < 2) return null;
                const x = Number(p[0]);
                const y = Number(p[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                return [Math.trunc(x), Math.trunc(y)];
            })
            .filter((p) => Array.isArray(p) && p.length === 2);

        const stepEvents = evts
            .map((e) => (e == null ? "" : String(e)))
            .map((e) => e.trim())
            .filter(Boolean);
        const mapUpdates = [];

        if (wallsToFree.length || freeToWalls.length) {
            const mapId =
                (typeof groundWallChanged?.mapId === "string" && groundWallChanged.mapId.trim())
                    ? groundWallChanged.mapId.trim()
                    : (mapIdFromTraceState(step?.after || {}) || mapIdFromTraceState(step?.before || {}));
            const mapName =
                (typeof groundWallChanged?.mapName === "string" && groundWallChanged.mapName.trim())
                    ? groundWallChanged.mapName.trim()
                    : (step?.after?.map?.name || step?.before?.map?.name);
            const mapIdText = mapId || "unknown";
            stepEvents.push(`Free Ground/Collision tiles changed on map ${mapIdText}`);
            if (wallsToFree.length) {
                const posAttr = wallsToFree.map(([x, y]) => `${x},${y}`).join("|");
                mapUpdates.push(
                    `- collision_to_free (${formatMapLabel(mapId, mapName)}): ${posAttr}`
                );
            }
            if (freeToWalls.length) {
                const posAttr = freeToWalls.map(([x, y]) => `${x},${y}`).join("|");
                mapUpdates.push(
                    `- free_to_collision (${formatMapLabel(mapId, mapName)}): ${posAttr}`
                );
            }
        }

        const tilesDiscovered = trace?.tilesDiscovered;
        const rawPositions = Array.isArray(tilesDiscovered?.positions) ? tilesDiscovered.positions : [];
        const positions = rawPositions
            .map((p) => {
                if (!Array.isArray(p) || p.length < 2) return null;
                const x = Number(p[0]);
                const y = Number(p[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                return [Math.trunc(x), Math.trunc(y)];
            })
            .filter((p) => Array.isArray(p) && p.length === 2);

        if (positions.length) {
            const mapId =
                (typeof tilesDiscovered?.mapId === "string" && tilesDiscovered.mapId.trim())
                    ? tilesDiscovered.mapId.trim()
                    : (mapIdFromTraceState(step?.after || {}) || mapIdFromTraceState(step?.before || {}));
            const mapName =
                (typeof tilesDiscovered?.mapName === "string" && tilesDiscovered.mapName.trim())
                    ? tilesDiscovered.mapName.trim()
                    : (step?.after?.map?.name || step?.before?.map?.name);
            const posAttr = positions.map(([x, y]) => `${x},${y}`).join("|");
            const msg =
                'You discovered new tiles on the minimap after executing your commands, some "?" are now visible.';
            stepEvents.push(msg);
            mapUpdates.push(
                `- tiles_discovered (${formatMapLabel(mapId, mapName)}): ${posAttr}`
            );
        }

        if (transcript.length) {
            lines.push("");
            lines.push("Transcript:");
            for (const t of transcript) {
                if (t == null) continue;
                lines.push(`- ${String(t)}`);
            }
        }

        if (stepEvents.length) {
            lines.push("");
            lines.push("Events:");
            for (const e of stepEvents) {
                lines.push(`- ${e}`);
            }
        }

        if (mapUpdates.length) {
            lines.push("");
            lines.push("Map updates:");
            lines.push(...mapUpdates);
        }

        if (step?.wait) {
            const w = step.wait;
            const okW = w?.ok ? "true" : "false";
            const toW = w?.timedOut ? "true" : "false";
            const activeW = w?.parsed?.active ?? "";
            const queueW = w?.parsed?.queue ?? "";
            lines.push("");
            lines.push("Wait:");
            lines.push(`- ok: ${okW}`);
            lines.push(`- timedOut: ${toW}`);
            if (activeW) lines.push(`- active: ${activeW}`);
            if (queueW) lines.push(`- queue: ${queueW}`);
        }

        if (step?.error) {
            lines.push("");
            lines.push("Error:");
            lines.push(String(step.error));
        }

        const newLastMapKey = mapKeyFromTraceState(afterState) || mapKeyFromTraceState(beforeState);
        if (newLastMapKey != null) lastMapKey = newLastMapKey;
    }

    return lines.join("\n").trim();
}

function defineTools() {
    // Individual schemas for each action type.
    const keyPressActionSchema = z.object({
        type: z.literal("key_press").describe("Action of pressing one or more keys."),
        keys: z.array(z.enum(ALLOWED_KEYPRESS_KEYS)).describe("Keys to send (e.g., 'up', 'down', 'left', 'right', 'a', 'b', 'start', 'select'). Use 'face_up', 'face_down', 'face_left', 'face_right' to change the orientation of the player without moving.")
    });

    const addMarkerActionSchema = z.object({
        type: z.literal("add_marker").describe("Action to create a custom marker on the minimap."),
        map_name: z.string().describe("Name of the map where to place the marker."),
        map_id: z.string().describe("ID of the map where to place the marker."),
        x: z.number().describe("X coordinate of the marker."),
        y: z.number().describe("Y coordinate of the marker."),
        emoji: z.string().describe("Emoji representing the marker. Choose a relevant emoji for the type of place."),
        label: z.string().describe("Detailed description of the marker. Make it as long as needed to be informative, do not be concise when it's needed."),
    });

    const writeMemoryActionSchema = z.object({
        type: z.literal("write_memory").describe("Action to write / update state.memory."),
        key: z.string().describe("Key for the information to memorize. Use prefixes to organize (e.g., 'location_', 'quest_', 'item_', 'tips_')."),
        value: z.string().describe("Value to memorize. Be precise and concise. Do not use for trivial information."),
    });

    const deleteMemoryActionSchema = z.object({
        type: z.literal("delete_memory").describe("Action to delete from state.memory."),
        key: z.string().describe("Key for the information to delete."),
    });

    const updateObjectivesActionSchema = z.object({
        type: z.literal("update_objectives").describe("Action to update the current game state.objectives."),
        primary: z.object({
            short_description: z.string().describe("The short description of the objective, must be a complete sentence. Do not be concise, resume the description in one sentence."),
            description: z.string().describe("Detailed data about the objective (Why / How etc ...)."),
        }).describe("The main objective. Use both short_description and description. Do not leave empty."),
        secondary: z.object({
            short_description: z.string().describe("The short description of the objective, must be a complete sentence. Do not be concise, resume the description in one sentence."),
            description: z.string().describe("Detailed data about the objective (Why / How etc ...)."),
        }).describe("The secondary objective. Use both short_description and description. Do not leave empty."),
        third: z.object({
            short_description: z.string().describe("The short description of the objective, must be a complete sentence. Do not be concise, resume the description in one sentence."),
            description: z.string().describe("Detailed data about the objective (Why / How etc ...)."),
        }).describe("The third objective. Use both short_description and description. Do not leave empty."),
        others: z.array(z.object({
            short_description: z.string().describe("The short description of the objective, must be a complete sentence. Do not be concise, resume the description in one sentence."),
            description: z.string().describe("Detailed data about the objective (Why / How etc ...)."),
        })).describe("List of other state.objectives. Each must have a short_description and description. Do not leave empty."),
    });

    // Schema for deleting a marker
    const deleteMarkerActionSchema = z.object({
        type: z.literal("delete_marker").describe("Action to delete a custom marker from the map."),
        map_id: z.string().describe("ID of the map where the marker is located."),
        x: z.number().describe("X coordinate of the marker to delete."),
        y: z.number().describe("Y coordinate of the marker to delete."),
    });

    // Pathfinding schema
    const pathfindingActionSchema = z.object({
        type: z.literal("path_to_location").describe("Action to pathfind to a specific location, use this action when you need to move more than 20 tiles in a row or for complex paths."),
        x: z.number().describe("X coordinate of the destination."),
        y: z.number().describe("Y coordinate of the destination."),
        map_id: z.string().describe("ID of the map where the destination is located."),
        explanation: z.string().describe(
            "Brief description of the movement plan including: " +
            "• Starting point and destination " +
            "• Purpose of the movement " +
            "• Any navigation preferences or conditions (e.g., 'Avoid tall grass if possible', 'Take shortest route to gym entrance')"
        ),
    });

    // Restart console schema
    const restartConsoleActionSchema = z.object({
        type: z.literal("restart_console").describe("Action to reboot the Game Boy console back to the title screen. BE SURE TO HAVE SAVED THE GAME BEFORE USING THIS TOOL."),
    });

    // Union of possible action schemas
    const actionUnionSchema = z.union([
        keyPressActionSchema,
        addMarkerActionSchema,
        writeMemoryActionSchema,
        deleteMemoryActionSchema,
        updateObjectivesActionSchema,
        deleteMarkerActionSchema,
        pathfindingActionSchema,
        restartConsoleActionSchema,
    ]);

    // Main schema for the execute_action tool
    const executeActionSchema = z.object({
        step_details: z.string().describe("An explanation of what happened in the previous step and what the next step is. Include all necessary details."),
        actions: actionUnionSchema.array().describe("One or multiple action(s) to execute"),
        chat_message: z.string().describe("A narrative comment describing your intent, reaction, or what happened during this step."),
        avatar_emotion: z.enum(AVATAR_EMOTIONS).describe("Select the avatar emotion that best matches your current mood, reaction, or activity. Choose from basic emotions (happy, sad, angry, etc.), specific reactions (surprised, confused, thinking, etc.), action-based emotions (reading, throwing_pokeball, etc.), or themed cosplay options when appropriate for the context."),
    });

    // Definition of the unique tool
    return [
        {
            type: "function",
            name: "execute_action",
            description: "Executes an action in the game: movement, interaction, or memorizing information. Adapt the action to the context (dialogue or free movement).",
            parameters: zodToJsonSchema(executeActionSchema),
            strict: config.tools.strict,
        },
    ];
}

/**
 * Handles the call of a specific tool requested by the AI.
 * @param {object} toolCall - The toolCall object from the OpenAI response.
 * @param {object} gameDataJson - The current game data
 * @returns {Promise<object>} The result of the function call for the history.
 */
async function handleToolCall(toolCall, gameDataJson) {
    const { name, arguments: argsString, call_id } = toolCall;
    const toolBatchStart = Date.now();
    let allActionResults = [];
    let overallSuccess = true;
    let keyPressExecutedThisTurn = false;
    let pathfindingExecutedThisTurn = false;

    if (name !== "execute_action") {
        console.error(`Error: Received unexpected tool call '${name}'.`);
        state.skipNextUserMessage = true;
        return {
            type: "function_call_output",
            call_id: call_id,
            output: [{ type: "input_text", text: `Error: Unexpected tool name '${name}'. Expected 'execute_action'.` }],
        };
    }

    let args;
    try {
        args = JSON.parse(argsString);
        console.log(`---> Tool Call Start: ${name} (ID: ${call_id})`);
        console.log(`Step Details: ${args.step_details}`);
        console.log(`Chat Message: ${args.chat_message}`);
        console.log(`Avatar Emotion: ${args.avatar_emotion}`);

        if (!args.actions || !Array.isArray(args.actions)) {
            throw new Error("'actions' argument is missing or is not an array.");
        }
        if (args.actions.length === 0) {
            console.error("ERROR: Tool call received with no actions to execute, it's forbidden to send an empty action.");
            state.skipNextUserMessage = true;
            console.log("Setting state.skipNextUserMessage = true due to empty action tool call.");
            return {
                type: "function_call_output",
                call_id: call_id,
                output: [{ type: "input_text", text: "ERROR: Tool call received with no actions to execute, it's forbidden to send an empty action." }],
            };
        }

        const restartConsolePresent = args.actions.some((action) => action.type === "restart_console");
        if (restartConsolePresent && args.actions.length > 1) {
            const errorText = "Error: 'restart_console' must be the ONLY action in the list. Remove all other actions and try again. (And be sure to have saved the game before using this tool.)";
            console.error(errorText);
            return {
                type: "function_call_output",
                call_id: call_id,
                output: [{ type: "input_text", text: errorText }],
            };
        }

        const batchActionStartPayload = {
            call_id: call_id,
            step_details: args.step_details,
            chat_message: args.chat_message,
            avatar_emotion: args.avatar_emotion,
            actions: args.actions,
        };
        broadcast({ type: 'action_start', payload: batchActionStartPayload });
        console.log(`---> Batch Action Start (ID: ${call_id}) - ${args.actions.length} actions`);

        for (let i = 0; i < args.actions.length; i++) {
            const individualAction = args.actions[i];
            const actionCallId = `${call_id}_${i}`;
            let actionResult = {
                action_type: individualAction.type,
                success: false,
                message: "",
                details: "",
            };

            console.log(`---> Executing Action ${i + 1}/${args.actions.length}: ${individualAction.type} (Sub-ID: ${actionCallId})`);
            try {
                switch (individualAction.type) {
                    case "key_press":
                        if (individualAction.keys.includes('start') && individualAction.keys.length > 1) {
                            actionResult.message = "Error: 'start' button cannot be used with other keys.";
                            actionResult.success = false;
                            overallSuccess = false;
                        }
                        else if (keyPressExecutedThisTurn) {
                            actionResult.success = false;
                            actionResult.message = "Error: Only one 'key_press' action is allowed per turn. Include all your keys inside one key_press action. You can send as many actions as you want, but only one key_press action in the list of actions is allowed.";
                            actionResult.details = "Skipping subsequent key_press actions.";
                            overallSuccess = false;
                            console.warn(`WARN: Skipping key_press action ${i + 1} as one was already executed this turn.`);
                        } else if (individualAction.keys && Array.isArray(individualAction.keys) && individualAction.keys.length > 0) {
                            const response = await sendCommandsToPythonServer(individualAction.keys);
                            actionResult.success = response.status;
                            actionResult.message = response.status
                                ? `Keys sent: ${individualAction.keys.join(', ')}`
                                : "Failed to send keys.";
                            actionResult.details_for_ai = summarizeTracePayloadMarkdown(response);
                            actionResult.details = "";
                            if (actionResult.success) {
                                keyPressExecutedThisTurn = true;
                            } else {
                                overallSuccess = false;
                            }
                        } else {
                            actionResult.message = "Error: 'keys' are missing, empty, or not an array.";
                            actionResult.success = false;
                            overallSuccess = false;
                        }
                        break;

                    case "add_marker":
                        const { map_id, map_name, x, y, emoji, label } = individualAction;
                        const xNum = Number(x);
                        const yNum = Number(y);
                        const xInt = Math.trunc(xNum);
                        const yInt = Math.trunc(yNum);
                        const markerKey = `${xInt}_${yInt}`;
                        if (!state.markers[map_id]) {
                            state.markers[map_id] = {};
                        }

                        // Check if the player is in a dialog, if so, don't add the marker
                        if (gameDataJson.is_talking_to_npc) {
                            actionResult.success = false;
                            actionResult.message = "Error: Player is in a dialog, cannot add a marker. Try again when the dialog is over.";
                            actionResult.details = "Marker not added.";
                            console.log(`INFO: Player is in a dialog, cannot add a marker.`);
                            break;
                        }

                        // Validate coordinates
                        if (!Number.isFinite(xNum) || !Number.isFinite(yNum)) {
                            actionResult.success = false;
                            actionResult.message = `Error: Invalid marker coordinates. x/y must be finite numbers (received x=${x}, y=${y}).`;
                            actionResult.details = "Marker not added.";
                            break;
                        }
                        if (xInt !== xNum || yInt !== yNum) {
                            actionResult.success = false;
                            actionResult.message = `Error: Invalid marker coordinates. x/y must be integers (received x=${x}, y=${y}).`;
                            actionResult.details = "Marker not added.";
                            break;
                        }

                        // Bounds check: prevent out-of-bounds markers on the map.
                        if (xInt < 0 || yInt < 0) {
                            actionResult.success = false;
                            actionResult.message = `Error: Marker (${xInt}, ${yInt}) is out of bounds for map ${map_id}. Coordinates must be >= 0.`;
                            actionResult.details = "Marker not added.";
                            break;
                        }
                        const bounds = await resolveMapBounds(gameDataJson, map_id);
                        if (bounds && (xInt >= bounds.width || yInt >= bounds.height)) {
                            actionResult.success = false;
                            actionResult.message =
                                `Error: Marker (${xInt}, ${yInt}) is out of bounds for map ${map_id} (${bounds.width}x${bounds.height}).`;
                            actionResult.details =
                                `Valid ranges: x=0..${bounds.width - 1}, y=0..${bounds.height - 1}.`;
                            break;
                        }

                        // Check if the marker already exists
                        if (state.markers[map_id][markerKey]) {
                            actionResult.success = false;
                            actionResult.message = `Marker already exists on map ${map_id} at (${xInt}, ${yInt}). Delete it before adding a new one.`;
                            actionResult.details = "Marker not added.";
                            console.log(`INFO: Marker already exists on map ${map_id} at ${markerKey}`);
                            break;
                        }
                        // No static MAP_NAMES table here: map names come from the Python bridge.
                        // We accept the provided map_id/map_name as-is.
                        // Attach NPC/object UID automatically when the marker falls on a known npc_entries position for the current map
                        let markerUid = null;
                        const npcEntries = Array.isArray(gameDataJson?.npc_entries) ? gameDataJson.npc_entries : null;
                        const playerMapId = gameDataJson?.current_trainer_data?.position?.map_id;
                        if (npcEntries && playerMapId === map_id) {
                            for (const entry of npcEntries) {
                                if (!entry || typeof entry !== "object") continue;
                                if (Number(entry.x) === xInt && Number(entry.y) === yInt) {
                                    markerUid = typeof entry.uid === "string" ? entry.uid : null;
                                    break;
                                }
                            }
                        }

                        const markerPayload = markerUid ? { emoji, label, map_name, uid: markerUid } : { emoji, label, map_name };
                        state.markers[map_id][markerKey] = markerPayload;
                        actionResult.success = true;
                        actionResult.message = `Marker added on map ${map_id} at (${xInt}, ${yInt}): ${emoji} ${label}`;
                        actionResult.details = "Marker stored.";
                        console.log(`INFO: Marker stored for map ${map_id} at ${markerKey}`);
                        if (actionResult.success) {
                            broadcast({ type: 'markers_update', payload: state.markers });
                        }
                        break;

                    case "write_memory":
                        if (individualAction.key && typeof individualAction.key === 'string' && typeof individualAction.value === 'string') {
                            state.memory[individualAction.key] = individualAction.value;
                            actionResult.success = true;
                            actionResult.message = `Information memorized: ${individualAction.key}`;
                            console.log(`INFO: Memorization: { ${individualAction.key}: \"${individualAction.value}\" }`);
                            if (actionResult.success) {
                                broadcast({ type: 'memory_update', payload: state.memory });
                            }
                        } else {
                            actionResult.message = "Error: 'key' or 'value' missing or not strings.";
                            actionResult.success = false;
                        }
                        break;

                    case "delete_memory":
                        if (individualAction.key && typeof individualAction.key === 'string') {
                            if (state.memory.hasOwnProperty(individualAction.key)) {
                                delete state.memory[individualAction.key];
                                actionResult.success = true;
                                actionResult.message = `Memory deleted: ${individualAction.key}`;
                                broadcast({ type: 'memory_update', payload: state.memory });
                            } else {
                                actionResult.success = false;
                                actionResult.message = `Error: Key '${individualAction.key}' not found in state.memory.`;
                            }
                        } else {
                            actionResult.message = "Error: 'key' missing or not a string.";
                            actionResult.success = false;
                        }
                        break;
                    case "update_objectives":
                        let updates = [];
                        let errorOccurred = false;
                        if (individualAction.hasOwnProperty('primary')) {
                            if (typeof individualAction.primary === 'object' && individualAction.primary.short_description && individualAction.primary.description) {
                                state.objectives.primary = individualAction.primary;
                                updates.push(`Primary set.`);
                            } else {
                                actionResult.message = "Error: 'primary' objective must be an object with a short_description and description.";
                                errorOccurred = true;
                            }
                        }
                        if (!errorOccurred && individualAction.hasOwnProperty('secondary')) {
                            if (typeof individualAction.secondary === 'object' && individualAction.secondary.short_description && individualAction.secondary.description) {
                                state.objectives.secondary = individualAction.secondary;
                                updates.push(`Secondary set.`);
                            } else {
                                actionResult.message = "Error: 'secondary' objective must be an object with a short_description and description.";
                                errorOccurred = true;
                            }
                        }

                        if (!errorOccurred && individualAction.hasOwnProperty('third')) {
                            if (typeof individualAction.third === 'object' && individualAction.third.short_description && individualAction.third.description) {
                                state.objectives.third = individualAction.third;
                                updates.push(`Third set.`);
                            } else {
                                actionResult.message = "Error: 'third' objective must be an object with a short_description and description.";
                                errorOccurred = true;
                            }
                        }
                        if (!errorOccurred && individualAction.hasOwnProperty('others')) {
                            if (Array.isArray(individualAction.others) && individualAction.others.every(item => typeof item === 'object' && item.short_description && item.description)) {
                                state.objectives.others = individualAction.others;
                                updates.push(`Others set.`);
                            } else {
                                actionResult.message = "Error: 'others' state.objectives must be an array of objects with a short_description and description.";
                                errorOccurred = true;
                            }
                        }

                        if (!errorOccurred) {
                            if (updates.length > 0) {
                                actionResult.success = true;
                                actionResult.message = "Objectives updated successfully.";
                                actionResult.details = updates.join(" ");
                                console.log(`INFO: Objectives updated. Details: ${actionResult.details}`);
                                broadcast({ type: 'objectives_update', payload: state.objectives });
                            } else {
                                actionResult.success = true;
                                actionResult.message = "No objective fields provided to update.";
                                actionResult.details = "No changes made.";
                            }
                        } else {
                            actionResult.success = false;
                        }
                        break;

                    case "delete_marker":
                        const { map_id: del_map_id, x: del_x, y: del_y } = individualAction;
                        const del_markerKey = `${del_x}_${del_y}`;
                        
                        // Check if the player is in a dialog, if so, don't delete the marker
                        if (gameDataJson.is_talking_to_npc) {
                            actionResult.success = false;
                            actionResult.message = "Error: Player is in a dialog, cannot delete a marker. Try again when the dialog is over.";
                            actionResult.details = "Marker not deleted.";
                            console.log(`INFO: Player is in a dialog, cannot delete a marker.`);
                            break;
                        }

                        if (state.markers[del_map_id] && state.markers[del_map_id][del_markerKey]) {
                            delete state.markers[del_map_id][del_markerKey];
                            if (Object.keys(state.markers[del_map_id]).length === 0) {
                                delete state.markers[del_map_id];
                            }
                            actionResult.success = true;
                            actionResult.message = `Marker deleted from map ${del_map_id} at (${del_x}, ${del_y})`;
                            actionResult.details = "Marker removed.";
                            console.log(`INFO: Marker deleted from map ${del_map_id} at ${del_markerKey}`);
                            broadcast({ type: 'markers_update', payload: state.markers });
                        } else {
                            actionResult.success = false;
                            actionResult.message = `Marker not found on map ${del_map_id} at (${del_x}, ${del_y})`;
                            actionResult.details = "No marker existed.";
                            console.log(`INFO: Attempted to delete non-existent marker at map ${del_map_id}, coords ${del_x}, ${del_y}`);
                        }
                        break;

                    case "path_to_location":
                        const { x: path_x, y: path_y, map_id: path_map_id, explanation: path_explanation } = individualAction;
                        let path = null;
                        let findPathError = null;
                        const maxRetries = 5;
                        console.log(`INFO: Finding path to (${path_x}, ${path_y}) on map ${path_map_id} with explanation: ${path_explanation}`);



                        // Check if the path_to_location action was already executed this turn
                        if (pathfindingExecutedThisTurn) {
                            actionResult.success = false;
                            actionResult.message = "Error: 'path_to_location' action was already executed this turn. Only one 'path_to_location' action is allowed per turn.";
                            actionResult.details = "Skipping subsequent path_to_location actions.";
                            overallSuccess = false; // Mark overall success as false
                            break;
                        }

                        for (let attempt = 1; attempt <= maxRetries; attempt++) {
                            try {
                                console.log(`INFO: Attempt ${attempt}/${maxRetries} to find path to (${path_x}, ${path_y}) on map ${path_map_id}`);
                                path = await findPath(path_x, path_y, path_map_id, path_explanation);
                                console.log(`INFO: Path found on attempt ${attempt}: ${path.keys}`);
                                findPathError = null; // Clear error on success
                                break; // Exit loop if path found successfully
                            } catch (error) {
                                console.error(`ERROR: Attempt ${attempt} failed for findPath(${path_x}, ${path_y}):`, error.message);
                                findPathError = error; // Store the last error
                                // Check if the error message contains "Player is not on map"
                                if (error.message.includes("Player is not on map")) {
                                    console.error(`ERROR: Player is not on map ${path_map_id}.`);
                                    actionResult.success = false;
                                    actionResult.message = `Player is not on map ${path_map_id}.`;
                                    break;
                                }
                                if (attempt === maxRetries) {
                                    console.error(`ERROR: findPath failed after ${maxRetries} attempts.`);
                                } else {
                                    // Optional: Add a small delay before retrying
                                    // await new Promise(resolve => setTimeout(resolve, 500));
                                }
                            }
                        }

                        if (path && path.reached_target && (!path.keys || path.keys.length === 0)) {
                            pathfindingExecutedThisTurn = true;
                            actionResult.success = true;
                            actionResult.message = `Already at target (${path_x}, ${path_y}). ${path.explanation || ""}`.trim();
                            actionResult.details = "No movement required.";
                            break;
                        }

                        if (path && path.keys && path.keys.length > 0) {
                            pathfindingExecutedThisTurn = true;
                            
                            const gameDataJson = await fetchGameData();
                            let finalKeysList = path.keys;
                            // Check if we are in a dialogue
                            if (gameDataJson.is_talking_to_npc) {
                                console.log(`Dialogue detected while calculating path, adding a_until_end_of_dialog to the path.`);
                                finalKeysList = ["a_until_end_of_dialog", ...path.keys];
                            }
                            const response = await sendCommandsToPythonServer(finalKeysList);
                            actionResult.success = response.status;
                            actionResult.message = response.status
                                ? `Explanation: ${path.explanation} \nKeys sequence generated by the path finding tool: "${path.keys.join(', ')}"`
                                : "Failed to send keys.";
                            const logs = summarizeTracePayloadMarkdown(response);
                            actionResult.details = `Keys execution result: ${logs || ""}`;
                        } else {
                            actionResult.success = false;
                            actionResult.message = findPathError
                                ? `Failed to find path to (${path_x}, ${path_y}) after ${maxRetries} attempts. Last error: ${findPathError.message}`
                                : `No path found or path was empty to (${path_x}, ${path_y}) \nExplanation: ${path.explanation}`;
                            actionResult.details = findPathError ? findPathError.stack : "Pathfinding logic returned empty path.";
                        }
                        break;
                    case "restart_console":
                        const restartResponse = await requestConsoleRestart();
                        // Wait 15 seconds before returning the result
                        await new Promise(resolve => setTimeout(resolve, 15000));
                        await sendCommandsToPythonServer(["a_until_end_of_dialog"]);
                        if (restartResponse?.status) {
                            actionResult.success = true;
                            actionResult.message = restartResponse.message || "Console restart requested successfully.";
                            actionResult.details = restartResponse.details || "";
                        } else {
                            actionResult.success = false;
                            actionResult.message = restartResponse?.message || "Error: Failed to restart the console.";
                            actionResult.details = restartResponse?.details || "";
                            overallSuccess = false;
                        }
                        break;
                    default:
                        actionResult.success = false;
                        actionResult.message = `Error: Unknown action type '${individualAction.type}'.`;
                }
            } catch (actionError) {
                // Catch errors specific to executing this single action
                console.error(`Error executing action type ${individualAction.type}:`, actionError);
                actionResult.success = false;
                actionResult.message = `Execution error for ${individualAction.type}: ${actionError.message}`;
                actionResult.details = actionError.stack;
            }
            // --- End Action Execution Logic ---

            const actionResultPayload = {
                call_id: actionCallId,
                action_type: individualAction.type,
                success: actionResult.success,
                message: actionResult.message,
                details: actionResult.details,
            };
            broadcast({ type: 'action_executed', payload: actionResultPayload });
            console.log(`<--- Action ${i + 1}/${args.actions.length} End: ${individualAction.type} (Sub-ID: ${actionCallId}) - Success: ${actionResult.success} ---`);


            // Store the result and update overall success
            allActionResults.push(actionResult);
            if (!actionResult.success) {
                overallSuccess = false;
                console.warn(`Action ${i + 1} (${individualAction.type}) failed. Subsequent actions in this step will still be attempted.`);
                // Optional: break here if you want to stop processing on the first failure
                // break;
            }
        }

    } catch (error) {
        // Catch errors from JSON parsing or initial validation before the loop
        overallSuccess = false;
        const errorMessage = `Tool call processing error (pre-execution): ${error.message}`;
        console.error(errorMessage, error);
        broadcast({ type: 'error_message', payload: errorMessage });
        // Add a placeholder result if no actions were even attempted
        if (allActionResults.length === 0) {
            allActionResults.push({
                action_type: 'setup_error',
                success: false,
                message: errorMessage,
                details: error.stack
            });
        }
    } finally {
        const durationMs = Date.now() - toolBatchStart;
        recordToolBatch({ callId: call_id, durationMs });
    }

    console.log(`<--- Tool Call End: ${name} (ID: ${call_id}) - Overall Success: ${overallSuccess} ---`);

    // Summarize the full action batch for the OpenAI history entry.
    const output = allActionResults
        .map((res) => {
            const details = res.details_for_ai != null ? res.details_for_ai : res.details;
            return `
    <action_result type="${xmlAttr(res.action_type)}" success="${res.success ? "true" : "false"}">
      <message>${xmlEscape(res.message || "")}</message>
      ${details ? `<details>${xmlEscape(details)}</details>` : ""}
    </action_result>
    `.trim();
        })
        .join("\n");

    // Return the formatted result for the OpenAI history
    return {
        type: "function_call_output",
        call_id: call_id, // Use the original call_id here too
        output: [{ type: "input_text", text: output.trim() }],
    };
}

async function findPath(x, y, map_id, explanation) {
    const gameDataJson = await fetchGameData();
    const pathfindingStart = Date.now();
    const { current_trainer_data } = gameDataJson;
    const { position } = current_trainer_data;

    // Check if the player map_id is the same as the map_id
    if (position.map_id !== map_id) {
        console.log(`ERROR: Player is not on map ${map_id}. Current map: ${position.map_id}`);
        throw new Error(`Player is not on map ${map_id}. Current map: ${position.map_id}`);
    }

    // Check if we are in a dialogue
    if (gameDataJson.is_talking_to_npc) {
        console.log(`ERROR: Player is in a dialogue. Cannot find path.`);
        throw new Error(`Player is in a dialogue. Cannot find path.`);
    }
    console.log(`INFO: Finding path to (${x}, ${y}) on map ${position.map_name} (${position.map_id})`);

    const grid = gameDataJson?.minimap_data?.grid;
    if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0])) {
        throw new Error("Minimap grid unavailable for pathfinding.");
    }

    const start = { x: Number(position.x), y: Number(position.y) };
    const target = { x: Number(x), y: Number(y) };
    if (![start.x, start.y, target.x, target.y].every(Number.isFinite)) {
        throw new Error(`Invalid coordinates for pathfinding: start (${position.x}, ${position.y}) target (${x}, ${y})`);
    }

    const movementMode = gameDataJson.player_movement_mode || "WALK";
    setIsThinking(true);
    try {
        const result = findLocalPath({
            grid,
            start,
            target,
            movementMode,
        });

        const pathfindingDuration = Date.now() - pathfindingStart;
        recordReasoningTime({
            type: "pathfinding",
            model: "local-pathfinder",
            serviceTier: "local",
            durationMs: pathfindingDuration,
        });

        recordPathfindingUsage({
            usage: {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                input_tokens_details: { cached_tokens: 0 },
            },
            cost: { fullCost: 0, discountedCost: 0 },
            model: "local-pathfinder",
            serviceTier: "local",
        });
        broadcast({
            type: 'token_usage',
            payload: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost: 0, discountedCost: 0 },
        });

        const reachedTarget = result.reachedTarget === true;
        const finalPos = result.finalPosition || start;
        const distance = Math.abs(finalPos.x - target.x) + Math.abs(finalPos.y - target.y);

        const explanationParts = [];
        if (reachedTarget) {
            explanationParts.push(`Local pathfinding reached (${target.x}, ${target.y}).`);
        } else {
            explanationParts.push(
                `Local pathfinding could not reach (${target.x}, ${target.y}); best reachable is (${finalPos.x}, ${finalPos.y}).`
            );
        }
        explanationParts.push(`Start: (${start.x}, ${start.y}). Movement mode: ${movementMode}.`);
        if (!reachedTarget) {
            explanationParts.push(`Remaining distance: ${distance}.`);
        }
        if (explanation) {
            explanationParts.push(`Request context: ${explanation}`);
        }

        return {
            keys: result.keys || [],
            explanation: explanationParts.join(" "),
            updated_code_path: "",
            reached_target: reachedTarget,
            final_position: finalPos,
        };
    } finally {
        setIsThinking(false);
    }
}

/**
 * Updates progress steps based on current game state
 * @param {object} gameDataJson - The current game data
 */

module.exports = { defineTools, handleToolCall, findPath };
