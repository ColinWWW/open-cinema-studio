# Live-link rendering with the visitor's own Comfy key

The live page (`web/` on GitHub Pages) can render without our render server: the visitor picks
**Comfy Cloud (your key)** in the Render panel, pastes their Comfy API key, and the page runs the same
two workflows the server runs (look still, then stage-1 Layout-to-Render) on their own Comfy account.

**Outcome (Oct 21):** browsers can't be shown to call Comfy Cloud directly, and the best evidence says
they can't (no CORS headers). So the page talks to Comfy through a tiny pass-through Worker
(`worker/`) that the deployer runs on Cloudflare's free tier. The page code is the same either way:
if Comfy Cloud ever answers browser calls, leaving the relay field blank goes straight to
`https://cloud.comfy.org`. A self-hosted ComfyUI behind `comfy-api-proxy --enable-cors-header <page
origin>` also works directly, with no relay. One check with a real key settles the Cloud question
(see [The one test to run](#the-one-test-to-run)).

## Findings

### 1. Does Comfy Cloud send CORS headers for browser calls?

**Not documented, and probably not.**

- Searching docs.comfy.org turned up nothing about browsers, CORS or keeping a key client-side for
  Comfy Cloud: the only CORS hit is ComfyUI's own `--enable-cors-header` startup flag for a
  self-hosted server ([API v2 overview](https://docs.comfy.org/api-reference/v2/overview),
  [SDKs](https://docs.comfy.org/development/api-development/sdks),
  [Cloud API overview](https://docs.comfy.org/api-reference/cloud/overview),
  [startup flags](https://docs.comfy.org/development/comfyui-server/startup-flags)). I could only read
  these through search results: this environment can't open docs.comfy.org.
- Comfy's own browser guidance is for the **self-hosted** proxy only: `comfy-api-proxy` has an opt-in
  `--enable-cors-header <origin>` that "Enables CORS preflight, `Authorization` / `Idempotency-Key`",
  and says "`@comfyorg/sdk` stays Node-only for v1 — browser apps should use `fetch` against
  `/api/v2/*`" ([comfy-api-proxy README](https://github.com/Comfy-Org/comfy-api-proxy),
  [docs/browser-access.md](https://github.com/Comfy-Org/comfy-api-proxy/blob/main/docs/browser-access.md)).
  So neither official SDK runs in a browser.
- Another challenge entrant hit exactly this: "Comfy's REST API sends no CORS headers, and neither do
  the upload and download links its MCP server hands out", and solved it with a Cloudflare Worker relay
  ([tawnkramer/ShotByShot#16](https://github.com/tawnkramer/ShotByShot/pull/16)). That's a third-party
  report, not Comfy's word, but it matches everything else.
- I couldn't probe `cloud.comfy.org` myself (even a free, keyless preflight): this environment's
  network policy blocks the host.

### 2. How workflows are submitted, files uploaded and results fetched

Read from the official Python SDK the server already uses (`comfy-sdk` 0.5.0 on PyPI:
`comfy_low/transport.py`, `comfy_sdk/_core.py`, `comfy_low/models/_generated.py`), which is the
contract for the Comfy API v2 that Comfy Cloud and `comfy-api-proxy` both serve:

| Step | Call |
|---|---|
| Base URL | `https://cloud.comfy.org/api/v2` (`COMFY_CLOUD_BASE_URL`); the SDK's `COMFY_BASE_URL` points it elsewhere |
| Auth | `Authorization: Bearer <COMFY_API_KEY>`, sent only to the base origin |
| Upload a file | `POST /assets`, multipart: `content_type`, `file_path`, `file` (optional `expected_hash`, `tags`) → `201` `Asset {id, hash, file_path, url, ...}` |
| Use it in a graph | the node input becomes `{"__type": "core/ASSET", "info": {"id": ..., "hash"?: ..., "file_path"?: ...}}` |
| Submit | `POST /jobs` with `{"workflow": <API-format graph>}` and an `Idempotency-Key` header → `201` `Job` |
| Status | `GET /jobs/{id}` → `status` (`queued`, `running`, `canceling`, then `succeeded` / `failed` / `canceled` / `expired`), `progress {value, current_node_class, step, steps}`, `outputs`, `error {message, node_id, class_type}` |
| Live progress | `GET /jobs/{id}/events` (SSE). The page polls `GET /jobs/{id}` instead, which carries the same progress snapshot. |
| Cancel | `POST /jobs/{id}/cancel` |
| Download | each output is an asset: `GET /assets/{output.id}/content`. On Cloud this answers with a redirect to a short-lived signed storage URL; self-hosted serves the bytes inline. |
| Errors | `{"error": {"code", "message", "details"}}`; `401 unauthorized`, `402 insufficient_credits`, `422 invalid_workflow` / `missing_asset`, `429 queue_full` + `Retry-After` |

Account notes from the docs: keys come from the Comfy platform account settings, and API access is
not on the Free tier ([Cloud API overview](https://docs.comfy.org/api-reference/cloud/overview)).
Each submit is a paid job on the visitor's account; nothing in the page retries a submit.

### 3. What a browser client needs

- `fetch` + `FormData` for the calls above. No SDK: the official ones are Python and Node-only.
- The workflow graphs. The page imports the committed `workflows/*.json` (generated by
  `server/workflow.py`, checked in CI) and sets the same inputs by node id as `server/render.py`
  does. A unit test checks the committed files, and on Oct 21 the JS-built graphs were identical to `server/workflow.py`'s for three clip sizes.
- Somewhere for the key: `localStorage` in the visitor's browser only.
- CORS on every response, including the signed download. That's the part Comfy Cloud doesn't give a
  web page, hence the relay.

## What's in the repo

- `web/src/cloud.js`: the browser client (upload, submit, poll, cancel, download), the graph
  builders, and key storage (`ocs.comfyKey`, `ocs.comfyBase` in localStorage).
- `web/src/render.js`: the Render panel gets a target picker, **Render server** or
  **Comfy Cloud (your key)**, with the key field, an optional relay URL, **Save & check** (a free
  `GET /jobs?limit=1`) and **Forget key**. The panel says the key is stored only in this browser and
  sent only to the URL shown. *Generate look still*, *3 variants*, *Render shot* and *Cancel* work on
  either target. *Render all shots* stays server-only, because it needs ffmpeg to cut the shots
  together.
- `worker/`: the relay. It forwards only the six Comfy API v2 calls the page makes, with a key, to
  Comfy Cloud for allowlisted page origins only, refuses uploads over 50 MB, passes on just `Authorization`, `Content-Type`, `Idempotency-Key`, `Accept`, `Range` and
  `If-None-Match`, drops cookies, follows the signed-storage redirect on downloads **without** the
  key (and only to https), and adds CORS headers. It has no storage bindings, no `console` calls, and Workers
  observability is off, so it keeps and logs nothing. The threat model and the Oct 21 security
  review are in [SECURITY.md](SECURITY.md).
- Tests: `web/test/cloud.test.js` (client and graphs, mocked fetch) and `web/test/worker.test.js`
  (relay, stubbed upstream), both in `npm test`.

Checked locally on Oct 21, no GPU and no paid calls: the page's code in Chromium against the mock
ComfyUI (`server/mock_comfyui.py`) behind the real `comfy-api-proxy` 0.1.6 with a token. It uploaded,
submitted, polled and downloaded a look still and a render, once directly (proxy started with
`--enable-cors-header`) and once through the relay running in Node in front of a proxy *without*
CORS. Calling that same CORS-less proxy directly was blocked by the browser, as expected for Cloud,
and the panel said so and pointed at the relay.

## Deploy the relay (not deployed yet)

Free Cloudflare account; nothing to pay for at this traffic (Workers free tier: 100k requests a day;
uploads are a few MB and the Worker only waits on the network, so CPU limits aren't an issue).

```bash
cd worker
# 1. Allow the page origins (no trailing slash, no path) in wrangler.toml [vars] ALLOWED_ORIGINS.
#    Default: https://colinwww.github.io plus the local dev/preview origins.
npx wrangler login
npx wrangler deploy          # -> https://ocs-comfy-relay.<your-subdomain>.workers.dev
```

Then on the live page: Render… → **Comfy Cloud (your key)** → paste the key → put the Worker URL in
**via** → **Save & check**. Visitors of the live page use the same relay URL with their own keys, so
put it in the README next to the live link once it's deployed.

Notes:
- The relay never sees a key unless a visitor sends one, and only in flight. Anyone can fake an
  `Origin` header outside a browser, so the allowlist stops other *web pages* from using the relay,
  not scripts. A script gains nothing from it, though: the relay only makes the page's own calls, with
  the caller's own key, which it could send to Comfy Cloud directly.
- Whoever deploys the relay could change it to log keys, so visitors should use one they trust.
  Every Pages site under `https://colinwww.github.io` shares one origin (and one `localStorage`); a
  custom domain for the live page, alone in `ALLOWED_ORIGINS`, keeps the key to this page only. See
  [SECURITY.md](SECURITY.md).
- `UPSTREAM` defaults to `https://cloud.comfy.org`. Point it at a deployment URL if Comfy gives you one.

## The one test to run

This needs a real Comfy API key and costs nothing:

1. Open the live page (or `cd web && npm run dev`), Render… → **Comfy Cloud (your key)**.
2. Paste the key, leave **via** blank (straight to `https://cloud.comfy.org`), **Save & check**.
   - **"Comfy API: https://cloud.comfy.org (key works)"**: Comfy Cloud allows browser calls, and no
     relay is needed for the API. Then run one look still (paid, on your credits). If its download
     fails, the signed-storage redirect is the part without CORS, and the relay is still needed.
   - **"could not reach … (CORS)"**: confirmed, so deploy the relay as above and check again with its URL.

The same check from DevTools on any https page:
`fetch('https://cloud.comfy.org/api/v2/jobs?limit=1', {headers: {Authorization: 'Bearer <key>'}})`.
A CORS error in the console means no.

After that, one real look still + render through the page is the end-to-end proof for the
submission (paid, the same jobs the server would submit).
