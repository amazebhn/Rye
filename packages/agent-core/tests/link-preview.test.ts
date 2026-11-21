import { describe, expect, test } from "bun:test";
import { assertPublicUrl, getLinkPreview, isPublicAddress, parseLinkPreview } from "../src/link-preview/preview.js";

describe("link preview address checks", () => {
  test("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip)).toBe(true);
  });

  test("blocks private, local and embedded-private addresses", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2002:c0a8:0101::1", "2001:db8::1", "not-an-ip",
    ]) expect(isPublicAddress(ip)).toBe(false);
  });

  test("rejects non-web schemes, credentials, odd ports and localhost", async () => {
    for (const url of ["file:///etc/passwd", "https://user:pw@example.com/", "http://example.com:8080/", "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest"]) {
      await expect(assertPublicUrl(new URL(url))).rejects.toThrow();
    }
  });

  test("getLinkPreview rejects invalid and private URLs with 400", async () => {
    await expect(getLinkPreview("not a url")).rejects.toMatchObject({ status: 400 });
    await expect(getLinkPreview("http://127.0.0.1/")).rejects.toMatchObject({ status: 400 });
  });
});

describe("link preview metadata", () => {
  const base = new URL("https://example.com/post/1");

  test("reads Open Graph tags, resolving relative URLs", () => {
    const html = `<html><head>
      <title>Fallback</title>
      <meta property="og:title" content="Hello &amp; welcome">
      <meta content='A post' property='og:description'>
      <meta property="og:site_name" content="Example">
      <meta property="og:image" content="/img/cover.png">
      <meta property="og:video:secure_url" content="https://cdn.example.com/clip.mp4">
      <meta property="og:video:type" content="video/mp4">
      <link rel="shortcut icon" href="/static/fav.png">
    </head></html>`;
    expect(parseLinkPreview(html, base)).toEqual({
      url: "https://example.com/post/1",
      title: "Hello & welcome",
      description: "A post",
      siteName: "Example",
      image: "https://example.com/img/cover.png",
      video: "https://cdn.example.com/clip.mp4",
      videoType: "video/mp4",
      favicon: "https://example.com/static/fav.png",
    });
  });

  test("falls back to <title>, meta description and /favicon.ico; drops non-web media URLs", () => {
    const html = `<title> Plain   page </title><meta name="description" content="Desc"><meta property="og:image" content="javascript:alert(1)">`;
    const p = parseLinkPreview(html, base);
    expect(p.title).toBe("Plain page");
    expect(p.description).toBe("Desc");
    expect(p.image).toBeUndefined();
    expect(p.favicon).toBe("https://example.com/favicon.ico");
  });
});
