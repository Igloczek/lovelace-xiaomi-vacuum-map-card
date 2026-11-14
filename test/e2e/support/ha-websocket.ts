import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A minimal Home Assistant websocket client for specs that run card modules in Node against the
 * real instance. It exposes the two pieces of `hass` the service-call code uses:
 * `connection.subscribeMessage` (for `render_template`) and `callService`.
 */
export interface RealHass {
    connection: {
        subscribeMessage: (
            callback: (msg: Record<string, unknown>) => void,
            message: Record<string, unknown>,
        ) => Promise<() => Promise<void>>;
    };
    callService: (
        domain: string,
        service: string,
        serviceData?: Record<string, unknown>,
        target?: Record<string, unknown>,
    ) => Promise<unknown>;
    sendMessage: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
    close: () => void;
}

const AUTH_FILE = path.join(__dirname, "..", ".auth", "token.json");

export async function connectRealHass(): Promise<RealHass> {
    const base = process.env.E2E_HA_URL || "http://localhost:8123";
    const token = (JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as { access_token: string }).access_token;
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/websocket`);
    let nextId = 1;
    const pending = new Map<number, { resolve: (m: Record<string, unknown>) => void; reject: (e: unknown) => void }>();
    const subscriptions = new Map<number, (event: Record<string, unknown>) => void>();

    await new Promise<void>((resolve, reject) => {
        socket.addEventListener("error", reject, { once: true });
        socket.addEventListener("message", event => {
            const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
            if (msg.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: token }));
            else if (msg.type === "auth_ok") resolve();
            else if (msg.type === "auth_invalid") reject(new Error(String(msg.message)));
            else if (msg.type === "result") {
                const entry = pending.get(msg.id as number);
                pending.delete(msg.id as number);
                if (!entry) return;
                if (msg.success) entry.resolve(msg);
                else entry.reject(msg.error);
            } else if (msg.type === "event") {
                subscriptions.get(msg.id as number)?.(msg.event as Record<string, unknown>);
            }
        });
    });

    const sendMessage = (message: Record<string, unknown>): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ ...message, id }));
        });

    return {
        connection: {
            subscribeMessage: async (callback, message) => {
                const id = nextId;
                subscriptions.set(id, callback);
                try {
                    await sendMessage(message);
                } catch (e) {
                    subscriptions.delete(id);
                    throw e;
                }
                return async () => {
                    subscriptions.delete(id);
                    await sendMessage({ type: "unsubscribe_events", subscription: id }).catch(() => undefined);
                };
            },
        },
        callService: async (domain, service, serviceData, target) =>
            (
                await sendMessage({
                    type: "call_service",
                    domain,
                    service,
                    service_data: serviceData ?? {},
                    ...(target ? { target } : {}),
                })
            ).result,
        sendMessage,
        close: () => socket.close(),
    };
}
