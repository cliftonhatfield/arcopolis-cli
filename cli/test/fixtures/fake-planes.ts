/**
 * Loopback `node:http` fake of both planes for the grant client tests (plan
 * §8): `GET /_developer/signup`, R1 `POST /_developer/cli/grants`, R2
 * `POST /_developer/cli/grants/poll`, and `GET /v1`. It plays the approving
 * human too: `approve()` encrypts a payload to the CLI's public key with the
 * PORTAL's own `developers/src/cli/envelope.ts`, exactly as the `/cli` page
 * does, so these tests exercise the real cross-implementation envelope.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { encryptGrantPayload } from "../../../developers/src/cli/envelope.ts";

type Json = Record<string, unknown>;

export const USER_CODE = "WDJB-MJHT";
export const NORMALIZED_USER_CODE = "WDJBMJHT";
export const DEVICE_CODE = `agnts_dc_${"1".repeat(64)}`;
export const VERIFICATION_URI = "https://developers.arcologylabs.com/cli";
export const READ_KEY = `agnts_${"2ea17d06".repeat(8)}`;
export const VISITOR_KEY = `agnts_${"4a792722".repeat(8)}`;

/** One request the fake received. */
export interface FakeRequest {
  method: string;
  path: string;
  body: Json | null;
  apiKey: string | undefined;
}

/** A canned answer: status, JSON body, and headers. */
export interface CannedResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** The grant as the fake server holds it. */
export interface FakeGrant {
  status: "pending" | "claimed" | "approved" | "consumed" | "denied" | "expired";
  userCode: string;
  deviceCode: string;
  publicKey: { kty: "EC"; crv: "P-256"; x: string; y: string };
  intent: Json;
  client: Json;
  expectedEmailSha256: string | null;
  expiresAt: string;
  envelope: unknown;
  resultSummary: Json | null;
}

export interface PayloadOptions {
  email?: string | null;
  userCode?: string;
  apiBase?: string;
  readKey?: Json | null;
  visitor?: Json | null;
  visitorCorpus?: Json | null;
  warnings?: string[];
  /** Encrypt for this code instead of the grant's (a mismatched envelope). */
  encryptForCode?: string;
}

/** The fake planes, with hooks the tests drive. */
export class FakePlanes {
  readonly requests: FakeRequest[] = [];
  grant: FakeGrant | null = null;
  origin = "";
  /** Answer R1 with this instead of creating a grant (401/404/503 fallbacks). */
  startResponse: CannedResponse | null = null;
  /** Answers for the next polls, in order, before the grant state is consulted. */
  pollQueue: CannedResponse[] = [];
  /** Called on every non-ack poll with the poll number (1-based); may change `grant`. */
  onPoll: ((count: number, planes: FakePlanes) => void | Promise<void>) | null = null;
  /** Called when the ack arrives, before it is applied. Return false to hold the response forever. */
  onAck: ((planes: FakePlanes) => boolean | Promise<boolean>) | null = null;
  /** Answers for the next acks, in order, instead of applying them. */
  ackQueue: CannedResponse[] = [];
  /** Called on every `GET /v1`. Return false to hold the response forever. */
  onVerify: ((planes: FakePlanes) => boolean | Promise<boolean>) | null = null;
  /** Keys `GET /v1` accepts. */
  readonly validKeys = new Set<string>([READ_KEY, VISITOR_KEY]);
  visitorWorldsOpen = 1;
  polls = 0;
  acks = 0;
  private server: Server | null = null;
  private held: ServerResponse[] = [];

  constructor(private readonly clock: () => number = Date.now) {}

  get dataBase(): string {
    return `${this.origin}/v1`;
  }

  get developerBase(): string {
    return `${this.origin}/_developer`;
  }

  /** Paths of every request, as `METHOD /path` (ack polls are marked). */
  get trace(): string[] {
    return this.requests.map((request) =>
      `${request.method} ${request.path}${request.body && request.body.ack === true ? " (ack)" : ""}`,
    );
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const response of this.held) response.destroy();
    this.held = [];
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** The default approved payload for the current grant (a created read key). */
  payload(options: PayloadOptions = {}): Json {
    const now = new Date(this.clock()).toISOString();
    const readKey =
      options.readKey === undefined
        ? {
            id: "key_read_1",
            key: READ_KEY,
            name: "my-project CLI 7f3a9c",
            tier: 1,
            scopes: ["agents:read", "posts:read", "trending:read", "search:read", "topics:read"],
            rateLimitPerMinute: 60,
            action: "created",
          }
        : options.readKey;
    const visitor = options.visitor === undefined ? null : options.visitor;
    const registered = visitor !== null && (visitor as Json).action === "registered";
    return {
      v: 1,
      userCode: options.userCode ?? NORMALIZED_USER_CODE,
      approvedAt: now,
      account: { uid: "uid_dev", email: options.email === undefined ? "dev@example.com" : options.email },
      apiBase: options.apiBase ?? this.dataBase,
      app: { id: "app_1", name: "my-project", created: true },
      readKey,
      visitor,
      terms: {
        developer: { version: "2026-09-23", url: "https://developers.arcologylabs.com/developer-api-terms.html" },
        visitorCorpus:
          options.visitorCorpus !== undefined
            ? options.visitorCorpus
            : registered
              ? { version: "2026-09-16", text: "Visitor text becomes part of the research corpus." }
              : null,
        acceptedAt: now,
      },
      warnings: options.warnings ?? [],
    };
  }

  /** Approves the grant: encrypts `payload` with the portal implementation and stores the envelope. */
  async approve(payload: Json = this.payload(), options: { encryptForCode?: string } = {}): Promise<void> {
    const grant = this.requireGrant();
    const envelope = await encryptGrantPayload(payload, {
      publicKey: grant.publicKey,
      normalizedUserCode: options.encryptForCode ?? NORMALIZED_USER_CODE,
    });
    const readKey = payload.readKey as Json | null;
    const visitor = payload.visitor as Json | null;
    grant.status = "approved";
    grant.envelope = envelope;
    grant.expiresAt = new Date(this.clock() + 600_000).toISOString();
    grant.resultSummary = {
      appId: (payload.app as Json).id,
      readKey: readKey ? { id: readKey.id, action: readKey.action } : null,
      visitor: visitor ? { agentId: visitor.agentId, keyId: visitor.keyId, action: visitor.action } : null,
      developerTermsVersion: "2026-09-23",
      visitorTermsVersion: visitor && visitor.action === "registered" ? "2026-09-16" : null,
    };
  }

  requireGrant(): FakeGrant {
    if (!this.grant) throw new Error("no grant was started");
    return this.grant;
  }

  private send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", ...headers });
    response.end(JSON.stringify(body));
  }

  private async readBody(request: IncomingMessage): Promise<Json | null> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return null;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
    } catch {
      return null;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await this.readBody(request);
    const apiKey = typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : undefined;
    this.requests.push({ method: request.method ?? "?", path: url.pathname, body, apiKey });
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /_developer/signup") {
      this.send(response, 200, { data: { open: true, termsVersion: "2026-09-16", visitorWorlds: { open: this.visitorWorldsOpen } } });
      return;
    }
    if (route === "POST /_developer/cli/grants") {
      if (this.startResponse) {
        this.send(response, this.startResponse.status, this.startResponse.body, this.startResponse.headers);
        return;
      }
      const start = body ?? {};
      this.grant = {
        status: "pending",
        userCode: USER_CODE,
        deviceCode: DEVICE_CODE,
        publicKey: start.publicKey as FakeGrant["publicKey"],
        intent: start.intent as Json,
        client: start.client as Json,
        expectedEmailSha256: (start.expectedEmailSha256 as string | null) ?? null,
        expiresAt: new Date(this.clock() + 600_000).toISOString(),
        envelope: null,
        resultSummary: null,
      };
      this.send(response, 201, {
        data: {
          userCode: USER_CODE,
          deviceCode: DEVICE_CODE,
          verificationUri: VERIFICATION_URI,
          verificationUriComplete: `${VERIFICATION_URI}#code=${USER_CODE}`,
          expiresAt: this.grant.expiresAt,
          expiresIn: 600,
          interval: 5,
        },
      });
      return;
    }
    if (route === "POST /_developer/cli/grants/poll") {
      await this.poll(response, body ?? {});
      return;
    }
    if (route === "GET /v1") {
      if (this.onVerify && !(await this.onVerify(this))) {
        this.held.push(response);
        return;
      }
      if (apiKey && this.validKeys.has(apiKey)) this.send(response, 200, { name: "Arcopolis Public API", version: "1.0.0" });
      else this.send(response, 401, { error: { code: "INVALID_API_KEY", message: "The API key is not valid." } });
      return;
    }
    this.send(response, 404, { error: { code: "NOT_FOUND", message: "Developer endpoint not found" } });
  }

  private async poll(response: ServerResponse, body: Json): Promise<void> {
    const grant = this.grant;
    if (!grant || body.deviceCode !== grant.deviceCode || String(body.userCode).replace("-", "") !== NORMALIZED_USER_CODE) {
      this.send(response, 404, { error: { code: "CLI_GRANT_NOT_FOUND", message: "That code is invalid or expired." } });
      return;
    }
    if (body.ack === true) {
      this.acks += 1;
      if (this.onAck && !(await this.onAck(this))) {
        this.held.push(response);
        return;
      }
      const cannedAck = this.ackQueue.shift();
      if (cannedAck) {
        this.send(response, cannedAck.status, cannedAck.body, cannedAck.headers);
        return;
      }
      if (grant.status === "approved") {
        grant.status = "consumed";
        grant.envelope = null;
        this.send(response, 200, { data: { status: "consumed" } });
        return;
      }
    } else {
      this.polls += 1;
      const canned = this.pollQueue.shift();
      if (canned) {
        this.send(response, canned.status, canned.body, canned.headers);
        return;
      }
      await this.onPoll?.(this.polls, this);
    }
    const expiresAt = grant.expiresAt;
    switch (grant.status) {
      case "pending":
        this.send(response, 200, { data: { status: "pending", expiresAt, interval: 5 } });
        return;
      case "claimed":
        this.send(response, 200, { data: { status: "claimed", claimedAt: new Date(this.clock()).toISOString(), expiresAt, interval: 5 } });
        return;
      case "approved":
        this.send(response, 200, {
          data: { status: "approved", approvedAt: new Date(this.clock()).toISOString(), expiresAt, envelope: grant.envelope, resultSummary: grant.resultSummary },
        });
        return;
      default:
        this.send(response, 200, { data: { status: grant.status } });
    }
  }
}
