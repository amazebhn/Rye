import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { AttachmentStore, classify, cleanName } from "../src/chat/attachments.js";
import { attachmentsForModel, mentionsAttachments, withoutImages } from "../src/agent/attachments.js";
import { readAttachmentForAgent } from "../src/tools/attachments.js";
import { parseDescription } from "../src/chat/describe-image.js";
import { ChatStore } from "../src/chat/store.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const PDF = new TextEncoder().encode("%PDF-1.4 fake");
const text = (s: string) => new TextEncoder().encode(s);

async function withStore(
  fn: (store: AttachmentStore, dir: string) => Promise<void>,
  opts: ConstructorParameters<typeof AttachmentStore>[1] = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "rye-attach-"));
  const store = new AttachmentStore(join(dir, "attachments"), {
    readPdf: async () => ({ text: "Quarterly report\n\nRevenue grew 12%.", pages: 3 }),
    ...opts,
  });
  try {
    await fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("what a file is", () => {
  test("judged by its bytes, not its name", () => {
    expect(classify("photo.txt", PNG)).toMatchObject({ kind: "image", mime: "image/png" });
    expect(classify("x.png", PDF)).toMatchObject({ kind: "pdf" });
    expect(classify("data.csv", text("a,b\n1,2"))).toMatchObject({ kind: "text", mime: "text/csv" });
    expect(classify("page.html", text("<script>alert(1)</script>"))).toMatchObject({ kind: "text" });
    expect(classify("blob.bin", new Uint8Array([0, 1, 2, 255, 0]))).toBeNull();
    expect(classify("bad.txt", new Uint8Array([0xc3, 0x28]))).toBeNull();
  });

  test("names lose folders and control characters", () => {
    expect(cleanName("../../etc/passwd")).toBe("passwd");
    expect(cleanName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(cleanName("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(cleanName("")).toBe("file");
  });
});

describe("AttachmentStore", () => {
  test("stores images, PDFs and text, reads their text, and refuses everything else", () =>
    withStore(async (store) => {
      const img = await store.add("screen.png", PNG);
      expect(img).toMatchObject({ kind: "image", name: "screen.png", caption: null });
      const pdf = await store.add("report.pdf", PDF);
      expect(pdf).toMatchObject({ kind: "pdf", pages: 3 });
      const csv = await store.add("rows.csv", text("a,b\n1,2"));
      expect(csv).toMatchObject({ kind: "text", chars: 7 });
      if ("error" in pdf || "error" in csv || "error" in img) throw new Error("upload failed");
      expect(store.text(pdf.id)).toContain("Revenue grew 12%");
      expect(store.image(img.id)?.mimeType).toBe("image/png");
      expect(await store.add("x.bin", new Uint8Array([0, 1, 0]))).toHaveProperty("error");
      expect(await store.add("empty.txt", new Uint8Array())).toHaveProperty("error");
      expect(store.get("att_../../etc")).toBeNull();
    }));

  test("a PDF without text, or without a reader, says why", () =>
    withStore(
      async (store) => {
        const scanned = await store.add("scan.pdf", PDF);
        expect(scanned).toMatchObject({ kind: "pdf", note: expect.stringContaining("no text layer") });
      },
      { readPdf: async () => ({ text: "  ", pages: 2 }) },
    ).then(() =>
      withStore(
        async (store) => {
          expect(await store.add("doc.pdf", PDF)).toMatchObject({ note: expect.stringContaining("pdftotext") });
        },
        { readPdf: async () => ({ error: "Rye can't read PDF text here: pdftotext isn't installed" }) },
      ),
    ));

  test("images are described in the background and the description reaches search", () =>
    withStore(
      async (store) => {
        const described: string[] = [];
        store.onDescribed = (att) => described.push(att.id);
        const img = await store.add("error.png", PNG);
        if ("error" in img) throw new Error(img.error);
        await store.idle();
        expect(store.get(img.id)).toMatchObject({ caption: "A login page showing a 502 error.", tags: ["error", "login"] });
        expect(described).toEqual([img.id]);
        expect(store.searchText(img.id)).toContain("502 error");
      },
      { captioner: async () => ({ caption: "A login page showing a 502 error.", tags: ["error", "login"] }) },
    ));

  test("unused attachments are pruned after the grace period; referenced and fresh ones stay", () =>
    withStore(async (store) => {
      const a = await store.add("a.txt", text("one"));
      const b = await store.add("b.txt", text("two"));
      if ("error" in a || "error" in b) throw new Error("upload failed");
      const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
      expect(store.prune(new Set([a.id]), 24 * 60 * 60 * 1000, Date.now())).toBe(0);
      expect(store.prune(new Set([a.id]), 24 * 60 * 60 * 1000, later)).toBe(1);
      expect(store.get(a.id)).not.toBeNull();
      expect(store.get(b.id)).toBeNull();
      expect(store.file(a.id) && existsSync(store.file(a.id)!.path)).toBe(true);
    }));
});

describe("what the model is given", () => {
  test("images go to a model that can see; text is included up to a budget with a way to read more", () =>
    withStore(async (store) => {
      const img = await store.add("shot.png", PNG);
      const long = await store.add("app.log", text("x".repeat(30_000)));
      if ("error" in img || "error" in long) throw new Error("upload failed");
      const seeing = attachmentsForModel([img, long], store, true);
      expect(seeing.images).toHaveLength(1);
      expect(seeing.note).toContain(`\`${img.id}\` **shot.png** — image`);
      expect(seeing.note).toContain("shown to you with this message only");
      expect(seeing.note).toContain(`read_attachment_tool(id="${long.id}", offset=16000)`);

      const blind = attachmentsForModel([img], store, false);
      expect(blind.images).toHaveLength(0);
      expect(blind.note).toContain("can't see images");
    }));

  test("saved history keeps the text reference but not the image", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "look `att_0123456789abcdef`" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 },
      { role: "toolResult", toolCallId: "t", toolName: "read_attachment_tool", content: [{ type: "text", text: "Image" }, { type: "image", data: "BBBB", mimeType: "image/png" }], isError: false, timestamp: 2 },
    ];
    const saved = withoutImages(messages);
    expect(saved[0].content).toBe("look `att_0123456789abcdef`");
    expect(JSON.stringify(saved)).not.toContain("AAAA");
    expect(JSON.stringify(saved)).not.toContain("BBBB");
    expect(mentionsAttachments(saved)).toBe(true);
    // The live copy is untouched.
    expect(JSON.stringify(messages)).toContain("AAAA");
  });

  test("read_attachment_tool pages through text and describes images", () =>
    withStore(
      async (store) => {
        const log = await store.add("app.log", text("abcdefghij"));
        const img = await store.add("shot.png", PNG);
        if ("error" in log || "error" in img) throw new Error("upload failed");
        await store.idle();
        expect(readAttachmentForAgent(store, { id: log.id, offset: 3, length: 4 })).toContain("defg");
        expect(readAttachmentForAgent(store, { id: log.id, offset: 3, length: 4 })).toContain("Continue with offset=7");
        expect(readAttachmentForAgent(store, { id: img.id })).toContain("Description: A cat.");
        expect(readAttachmentForAgent(store, { id: "att_nope" })).toContain("no attachment");
      },
      { captioner: async () => ({ caption: "A cat.", tags: [] }) },
    ));

  test("a vision model's reply is read even with a fence or chatter around the JSON", () => {
    expect(parseDescription('```json\n{"description":"A chart.","tags":["Chart","chart","sales"]}\n```')).toEqual({ caption: "A chart.", tags: ["chart", "sales"] });
    expect(parseDescription("no json here")).toBeNull();
    expect(parseDescription('{"description":""}')).toBeNull();
  });
});

describe("finding messages by their attachments", () => {
  test("names now and descriptions once written are searchable; references are tracked", () =>
    withStore(async (store, dir) => {
      const chats = new ChatStore(join(dir, "chats.db"), null, null);
      chats.attachmentText = (id) => store.searchText(id);
      try {
        const img = await store.add("checkout-error.png", PNG);
        if ("error" in img) throw new Error(img.error);
        const ref = { id: img.id, name: img.name, kind: img.kind, mime: img.mime, size: img.size };
        chats.upsert({
          id: "c1", title: "Untitled", sessionId: "s1", updatedAt: Date.now(),
          messages: [{ role: "user", content: "", attachments: [ref] }, { role: "assistant", content: "Looks like a gateway problem." }],
        } as never);
        expect((await chats.search("checkout")).map((h) => h.chatId)).toEqual(["c1"]);
        expect(await chats.search("gateway timeout banner")).toEqual([]);

        // The description arrives later.
        store.setCaptioner(async () => ({ caption: "A checkout page with a gateway timeout banner.", tags: ["timeout"] }));
        store.describeLater(img.id);
        await store.idle();
        expect(chats.refreshAttachmentText(img.id)).toBe(1);
        expect((await chats.search("gateway timeout banner")).map((h) => h.chatId)).toEqual(["c1"]);
        expect(chats.referencedAttachmentIds()).toEqual(new Set([img.id]));
      } finally {
        chats.close();
      }
    }));
});
