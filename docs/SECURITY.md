# Security

This covers the one place Open Cinema Studio handles a secret: **rendering with the visitor's own
Comfy API key** on the live page (`web/src/cloud.js`, the `worker/` relay, set up in
[LIVE_RENDER.md](LIVE_RENDER.md)). The render server (`server/`) is meant for your own machine or pod and
keeps its key in its own environment; its hardening is in PR #14.

Since then the page also takes a second key: the visitor's own **Claude API key** for the scene agent
(`web/src/agent/`, [AGENTS.md](AGENTS.md)). It is handled the same way, and the same threat model below
applies to it:

- It is saved only in this browser's `localStorage` as `ocs.claudeKey`, typed into a password field, and
  sent only to the URL in the agent's **via** field (blank = `https://api.anthropic.com`).
- The **via** field is checked the same way as the Comfy one (https only, except localhost; no bare
  words, so a key pasted into the wrong field is refused).
- Everything the model sends back (the log, its summary, the drafted prompt) is shown as plain text only.
  The tools validate every input before it touches the scene.

If a Claude key leaks, revoke it in the [Claude Console](https://console.anthropic.com).

## Reporting an issue

Please don't open a public issue for anything that could expose someone's key. Use GitHub's private
reporting instead: **Security → Report a vulnerability** on
[ColinWWW/open-cinema-studio](https://github.com/ColinWWW/open-cinema-studio/security/advisories/new).
Say what you found, how to reproduce it, and which commit or page you tested. If you think a key has already leaked, revoke it on
[platform.comfy.org](https://platform.comfy.org) first: that's the only real fix for a leaked key.

## Threat model

**What we protect:** the visitor's Comfy API key, which can spend their Comfy credits.

**Where it lives:** typed into the Render panel, saved in this browser's `localStorage` as
`ocs.comfyKey`, and sent in an `Authorization: Bearer` header to the one URL in the **via** field
(blank = `https://cloud.comfy.org`). Nobody running this project ever receives it, except in flight
through a relay that the visitor chose to use.

**Who we defend against:**

| Attacker | Protected? |
|---|---|
| Another website the visitor has open | Yes. It can't read our origin's storage, and the relay refuses its origin. |
| Someone who sees the page, a screenshot or a screen recording | Yes. The key field is a password field, and error text has the key cut out. |
| Someone who gets the page URL (a shared scene link, server logs, Referer) | Yes. The key is never in a URL, and API calls send no Referer. |
| A misbehaving or compromised Comfy API answer | Yes for the page: answers are shown as plain text only. Yes for the relay: it only follows a download redirect, and only to https. |
| Someone using the relay as a free proxy | Mostly. Only the six calls the page makes, only to Comfy Cloud, only with a key, 50 MB per upload. Scripts can fake `Origin`, but they gain nothing they couldn't get by calling Comfy directly. |
| The relay's operator (Cloudflare account owner) | **No.** The key passes through the Worker in flight. The code stores and logs nothing, but whoever deploys it could change that. Use a relay you or someone you trust deployed, or deploy your own. |
| Code running on our origin (a compromised npm dependency, or another GitHub Pages site under `colinwww.github.io`) | **No.** Anything that runs on the page's origin can read `localStorage`. See finding 8. |
| Malware or extensions on the visitor's computer | **No.** Out of scope for a web page. |

## Review (Oct 21, 2026)

Reviewed as an attacker would: `web/src/cloud.js`, how `web/src/render.js` uses it, `worker/src/index.js`,
`worker/wrangler.toml` and `web/index.html`. Every fix has a test in `web/test/cloud.test.js` or
`web/test/worker.test.js`, run by `npm test` in CI. No real key was used and the Worker was not deployed.

### Fixed

1. **The relay forwarded any `/api/v2/*` path with any method.** Anyone could reach every Comfy API v2
   endpoint through it (workspaces, deletes, and anything Comfy adds later). Now it relays only the
   six calls the page makes (`GET`/`POST /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/cancel`,
   `POST /assets`, `GET /assets/{id}/content`), ids are plain `[A-Za-z0-9_-]`, so encoded `../`
   or `/` can't sneak through, and preflight no longer offers `DELETE`. Other paths get a 404, other
   methods a 405, and nothing goes upstream.
2. **A key pasted into the "via" field was sent out as a hostname.** `comfyui-abc…` became
   `https://comfyui-abc…`, which leaks the key to the DNS resolver, shows it in the status line
   ("Checking https://comfyui-abc…"), and sends it in the header to that "host". Dotless hostnames
   (other than `localhost`) are now refused with a hint, before any request.
3. **A key with a stray space or newline could end up on screen.** `fetch` refuses such a header and
   its error message can quote the whole value (`"Bearer <key>\n" is an invalid header value`), which
   the panel then showed as "could not reach … (CORS)". The client now rejects keys that aren't one
   token of printable ASCII, with a clear message, and every error string (from the network layer or an
   upstream body) has the key replaced by `[your key]`, control characters removed, and a 300-character cap.
4. **API calls sent the page URL as `Referer`, and could send cookies, to the via host.** Brief 13 puts
   a shared scene in the page URL, so the relay or self-hosted proxy would see every scene. Calls now use
   `referrerPolicy: 'no-referrer'` and `credentials: 'omit'`.
5. **The relay buffered request bodies with no limit.** Bodies over 50 MB (a declared
   `Content-Length`, or a streamed body as soon as it passes the cap) now get a 413 before anything
   goes upstream. A 1080p playblast is a few MB; Cloudflare's own cap is 100 MB.
6. **The relay forwarded requests with no key.** It now answers 401 itself unless there's an
   `Authorization: Bearer …` header, so it can never be an anonymous proxy and never spends a
   round trip to Comfy on an empty call.
7. **The relay followed any redirect on any GET, to any scheme.** It now follows only the download
   redirect (`/assets/{id}/content`), only to `https://`, and still without the key. A redirect from
   any other call goes back to the page unfollowed. A test also checks the Worker has no `console`,
   cache or storage calls, and that `wrangler.toml` has no storage bindings and observability off.

### Accepted, with the reason

8. **Any script on the page's origin can read the key.** That's how `localStorage` works, and the
   alternatives are worse for a static page: no storage means retyping the key on every visit,
   and there's no server to hold it. Two things widen this origin:
   - **GitHub Pages project sites share one origin.** Every site under `https://colinwww.github.io/*`
     is the same origin, so any other Pages project on that account could read `ocs.comfyKey` and is
     also allowed by the relay's `ALLOWED_ORIGINS`. Today that's only this owner's own sites.
     A custom domain for the live page (and that domain alone in `ALLOWED_ORIGINS`) closes it.
   - **Third-party code.** The page loads no third-party scripts, fonts or analytics: `index.html`
     loads only `/src/main.js` and `/src/style.css`, and the dependencies (`three`, `mp4-muxer`, and
     `@anthropic-ai/sdk`, which loads only when the scene agent runs) are pinned exact versions bundled
     at build time. A malicious release of any of them could still read the keys, so upgrades should stay deliberate. A Content-Security-Policy meta tag in `index.html`
     (`script-src 'self'`, `connect-src` limited to https) would be a good follow-up; it's outside
     this review's files.
9. **The relay's `Origin` allowlist doesn't stop scripts.** `curl` can send any `Origin`. With
   fixes 1, 6 and 7 the relay only lets a script do what it could already do against Comfy Cloud
   directly with its own key, so there's nothing to gain. Abuse would cost the deployer Worker
   requests (100k a day free), not money; Cloudflare's rate limiting can be added if it ever happens.
10. **The key is sent to whatever https URL the visitor types in "via".** That's the feature: a
    relay or a self-hosted proxy. The page says so next to the field ("sent only to the URL above"),
    only https is allowed (http only for this machine), and URLs with a user:password, query or
    fragment are refused. A visitor talked into pasting an attacker's URL would hand over their key,
    the same as pasting it into any other site.
11. **Browsers may offer to save the key as a password.** The field is `type="password"` with
    `autocomplete="off"`, which Chrome ignores for password fields, and there's no `<form>`, so a
    save prompt is unlikely but possible. If saved, it's in the browser's password manager, not on the
    page. Changing the field is outside this review's files (it's in `render.js`).
12. **On a direct Comfy URL, the browser follows the download redirect itself.** Current Chrome,
    Firefox and Safari drop `Authorization` on a cross-origin redirect (Fetch spec), so the signed
    storage host doesn't see the key. Very old browsers might send it. Through the relay this can't
    happen: the relay follows the redirect without the key (fix 7).

### Checked, nothing to fix

- **Markup injection from upstream errors.** Every place the panel shows an error or status
  (`render-server`, `render-status`, hints) uses `textContent`. The two `innerHTML` uses in
  `render.js` are fixed strings with no data in them. A test checks that an `<img onerror>` in an
  error body comes out as the same literal text, which the panel then sets with `textContent`.
- **Logs.** No `console` call anywhere in `cloud.js`, `render.js` or the Worker, and Workers
  observability is off in `wrangler.toml`.
- **The URL.** The key is only ever in a header. The page's own URL never carries it. When the scene
  share link (brief 13) lands, it should encode the scene only; worth a look in its review.
- **Other origins through the relay.** The relay passes upstream only `Authorization`,
  `Content-Type`, `Idempotency-Key`, `Accept`, `Range` and `If-None-Match`, drops `Set-Cookie` and
  upstream CORS headers, never sets `Access-Control-Allow-Credentials`, and answers CORS only for
  the listed origins (the Pages origin plus the local dev and preview ones).
- **Where the key is written.** Only `localStorage['ocs.comfyKey']`, nowhere else: not
  `sessionStorage`, cookies, IndexedDB, the URL or the exported files. A test checks what
  `saveCloud` writes.

### Open: needs a file outside this review

13. **Forget key can silently fail.** **Forget key** clears the field and calls the same save as
    **Save & check**, which first validates the via URL. If the via field holds something invalid
    (say `http://relay.example.com`), it shows the error and returns *before* removing the key, so
    the key stays in `localStorage` and in memory. The fix is one line in `web/src/render.js`'s Forget
    handler: call `saveCloud({ key: '', base: cloud.base })` and set `cloud.key = ''` before
    validating. `render.js` is outside this review's files; it fits brief 16, which already edits it.
    Until then, the browser's "clear site data" always removes the key.

## For visitors

- Use a key you can revoke, and revoke it on platform.comfy.org if you're unsure.
- Click **Forget key** when you're done on a shared computer, or clear this site's data in the browser.
- Use a relay you trust. Once a relay URL is in the README, it's one this project's author deployed; you can
  deploy your own in a few minutes ([LIVE_RENDER.md](LIVE_RENDER.md#deploy-the-relay-not-deployed-yet)).
