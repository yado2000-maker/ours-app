// WhatsApp Provider Abstraction Layer
// Supports both Whapi.Cloud (interim) and Meta Cloud API (target)

export interface IncomingMessage {
  messageId: string;
  groupId: string;          // Group JID for groups, phone number for direct messages (reply-to address)
  senderPhone: string;
  senderName: string;
  text: string;
  type: "text" | "image" | "sticker" | "voice" | "video" | "document" | "reaction" | "other";
  timestamp: number;
  chatType: "group" | "direct";
  mediaUrl?: string;
  mediaId?: string;
  mediaDuration?: number;
}

export interface OutgoingMessage {
  groupId: string;
  text: string;
}

export interface GroupEvent {
  type: "group_event";
  groupId: string;
  subtype: "add" | "remove" | "promote" | "demote";
  participants: string[]; // phone numbers (without @s.whatsapp.net)
  actorPhone: string;     // who performed the action
  timestamp: number;
}

export interface WhatsAppProvider {
  name: string;
  verifyWebhook(req: Request): Promise<boolean>;
  parseIncoming(body: unknown): IncomingMessage | null;
  parseGroupEvent?(body: unknown): GroupEvent | null;
  sendMessage(msg: OutgoingMessage): Promise<boolean>;
  sendTemplate?(groupId: string, template: string, params: Record<string, string>): Promise<boolean>;
}

// ─── Whapi.Cloud Provider (Interim) ───

export class WhapiProvider implements WhatsAppProvider {
  name = "whapi";
  private apiUrl: string;
  private token: string;

  constructor() {
    this.apiUrl = Deno.env.get("WHAPI_API_URL") || "https://gate.whapi.cloud";
    this.token = Deno.env.get("WHAPI_TOKEN") || "";
  }

  async verifyWebhook(req: Request): Promise<boolean> {
    // Whapi uses a simple bearer token for webhook verification
    const authHeader = req.headers.get("authorization");
    const webhookToken = Deno.env.get("WHAPI_WEBHOOK_TOKEN");
    if (!webhookToken) return true; // Skip verification if no token set (dev mode)
    return authHeader === `Bearer ${webhookToken}`;
  }

  parseIncoming(body: unknown): IncomingMessage | null {
    try {
      const data = body as Record<string, unknown>;

      // Whapi webhook format: https://whapi.readme.io/reference/webhooks
      const messages = (data.messages || []) as Array<Record<string, unknown>>;
      if (messages.length === 0) return null;

      const msg = messages[0];
      const chatId = msg.chat_id as string || "";

      // Determine chat type: group (@g.us) or direct (@s.whatsapp.net)
      let chatType: "group" | "direct";
      let groupId: string;
      if (chatId.endsWith("@g.us")) {
        chatType = "group";
        groupId = chatId;
      } else if (chatId.endsWith("@s.whatsapp.net")) {
        chatType = "direct";
        groupId = chatId.replace("@s.whatsapp.net", ""); // Phone number as reply-to address
      } else {
        return null; // Unknown chat format
      }

      const from = msg.from as string || "";
      const fromName = msg.from_name as string || from;
      const text = (msg.text as Record<string, string>)?.body || "";
      const type = msg.type as string || "text";
      const id = msg.id as string || "";
      const timestamp = (msg.timestamp as number) || Math.floor(Date.now() / 1000);

      // Extract media info for voice messages (ptt = push-to-talk, audio = audio file)
      const audioData = (msg.ptt || msg.audio || msg.voice) as Record<string, unknown> | undefined;
      const mediaUrl = (audioData?.link as string | undefined) || undefined;
      const mediaId = audioData?.id as string | undefined;
      const mediaDuration = (audioData?.seconds ?? audioData?.duration) as number | undefined;

      // Map Whapi message types to our types
      const typeMap: Record<string, IncomingMessage["type"]> = {
        text: "text",
        image: "image",
        sticker: "sticker",
        ptt: "voice",
        audio: "voice",
        voice: "voice",
        video: "video",
        document: "document",
        reaction: "reaction",
      };

      return {
        messageId: id,
        groupId,
        senderPhone: from.replace("@s.whatsapp.net", ""),
        senderName: fromName,
        text: text,
        type: typeMap[type] || "other",
        timestamp,
        chatType,
        mediaUrl,
        mediaId,
        mediaDuration,
      };
    } catch (err) {
      console.error("[WhapiProvider] Parse error:", err);
      return null;
    }
  }

  parseGroupEvent(body: unknown): GroupEvent | null {
    try {
      const data = body as Record<string, unknown>;
      const messages = (data.messages || []) as Array<Record<string, unknown>>;
      if (messages.length === 0) return null;

      const msg = messages[0];
      const type = msg.type as string || "";

      // Whapi sends group events as type "action" with subtypes: add, remove, promote, demote
      if (type !== "action") return null;

      const chatId = msg.chat_id as string || "";
      if (!chatId.endsWith("@g.us")) return null;

      const subtype = msg.subtype as string || "";
      const validSubtypes = ["add", "remove", "promote", "demote"];
      if (!validSubtypes.includes(subtype)) return null;

      const action = msg.action as Record<string, unknown> || {};
      const rawParticipants = (action.participants || []) as string[];
      const participants = rawParticipants.map((p: string) => p.replace("@s.whatsapp.net", ""));

      const from = msg.from as string || "";
      const timestamp = (msg.timestamp as number) || Math.floor(Date.now() / 1000);

      return {
        type: "group_event",
        groupId: chatId,
        subtype: subtype as GroupEvent["subtype"],
        participants,
        actorPhone: from.replace("@s.whatsapp.net", ""),
        timestamp,
      };
    } catch (err) {
      console.error("[WhapiProvider] parseGroupEvent error:", err);
      return null;
    }
  }

  async sendMessage(msg: OutgoingMessage): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/messages/text`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: msg.groupId,
          body: msg.text,
        }),
      });
      return res.ok;
    } catch (err) {
      console.error("[WhapiProvider] Send error:", err);
      return false;
    }
  }
}

// ─── Meta Cloud API Provider (Target) ───

export class MetaCloudProvider implements WhatsAppProvider {
  name = "meta";
  private phoneNumberId: string;
  private accessToken: string;
  private appSecret: string;

  constructor() {
    this.phoneNumberId = Deno.env.get("META_PHONE_NUMBER_ID") || "";
    this.accessToken = Deno.env.get("META_ACCESS_TOKEN") || "";
    this.appSecret = Deno.env.get("META_APP_SECRET") || "";
  }

  async verifyWebhook(req: Request): Promise<boolean> {
    // Meta uses HMAC-SHA256 signature verification
    const signature = req.headers.get("x-hub-signature-256") || "";
    if (!signature || !this.appSecret) return false;

    const body = await req.clone().text();
    const key = new TextEncoder().encode(this.appSecret);
    const data = new TextEncoder().encode(body);
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
    const hex = "sha256=" + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");

    return hex === signature;
  }

  parseIncoming(body: unknown): IncomingMessage | null {
    try {
      const data = body as Record<string, unknown>;
      const entry = ((data.entry || []) as Array<Record<string, unknown>>)[0];
      if (!entry) return null;

      const changes = ((entry.changes || []) as Array<Record<string, unknown>>)[0];
      if (!changes) return null;

      const value = changes.value as Record<string, unknown>;
      const messages = (value.messages || []) as Array<Record<string, unknown>>;
      if (messages.length === 0) return null;

      const msg = messages[0];
      const contacts = (value.contacts || []) as Array<Record<string, unknown>>;
      const contact = contacts[0] || {};

      const from = msg.from as string || "";
      const text = (msg.text as Record<string, string>)?.body || "";
      const type = msg.type as string || "text";
      const id = msg.id as string || "";
      const timestamp = parseInt(msg.timestamp as string || "0");

      // For groups, the group_id is in the metadata
      const groupId = (msg as Record<string, unknown>).group_id as string || "";

      return {
        messageId: id,
        groupId,
        senderPhone: from,
        senderName: (contact.profile as Record<string, string>)?.name || from,
        text,
        type: type as IncomingMessage["type"],
        timestamp,
      };
    } catch (err) {
      console.error("[MetaCloudProvider] Parse error:", err);
      return null;
    }
  }

  async sendMessage(msg: OutgoingMessage): Promise<boolean> {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v19.0/${this.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: msg.groupId,
            type: "text",
            text: { body: msg.text },
          }),
        }
      );
      return res.ok;
    } catch (err) {
      console.error("[MetaCloudProvider] Send error:", err);
      return false;
    }
  }
}

// ─── Factory ───

export function createProvider(): WhatsAppProvider {
  const providerType = Deno.env.get("WHATSAPP_PROVIDER") || "whapi";
  switch (providerType) {
    case "meta": return new MetaCloudProvider();
    case "whapi": return new WhapiProvider();
    default: return new WhapiProvider();
  }
}
