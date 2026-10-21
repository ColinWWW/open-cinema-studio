# Name shortlist

The project is still "Open Cinema Studio" / "Name TBD". Colin picks; nothing is renamed until he does.
Checked Oct 21, 2026. Avoids the rivals' names (comfyrizz, Scumble) and doesn't lean on "Higgsfield",
which is another company's brand.

## How each name was checked

- **GitHub:** a repository search by name (`<name> in:name`) across all of GitHub. The repo would be
  `ColinWWW/<name>`, which is free for every name here (Colin has no repo by these names); the search
  is about whether someone else already uses the name for a similar tool.
- **Products:** a web search for the name as an app or product.
- **Domains:** **not verified.** The registry lookups (RDAP for .com at Verisign, .dev at Google) are
  blocked from the environment this was written in, so the column below only says whether a web search
  found a site on the .com or .dev. Before deciding, check the pick at any registrar (one search covers
  both). Registration status is the one thing on this page that needs Colin.

## Shortlist

| Name | Why it fits | GitHub (`in:name` search) | Domains (.com / .dev) | Clashes |
|---|---|---|---|---|
| **Greycut** | Grey layout in, finished cut out: the grey boxes and the sequence of shots in one word | 0 repos | No site found for either; registration not checked | None found. US spelling "graycut" should redirect to it |
| **Blocking Pass** | "Blocking" is exactly what the editor does, and a "pass" is VFX language for one layer of a shot | 0 repos for `blockingpass` / `blocking-pass` | No site found for either; registration not checked | None found. Blocker (Afternow), a phone previs app from 2018, is close in meaning but not in name |
| **Miseboard** | From *mise-en-scène*: arranging everything in the frame, as a board you work on | 0 repos | No site found; registration not checked | None found. Harder to spell and say out loud |
| **Greyshot** | Grey shot in, real shot out; short and literal | 2 repos in one data org (`greyshot-project`), unrelated | No site found; registration not checked | Possibly a Windows screenshot tool of that name (unconfirmed) |
| **Dollygrip** | The crew member who pushes the camera dolly: you set the move, the model does the driving | 1 repo, created Oct 20, 2026, empty description | Not checked by search; registration not checked | Common film term, so hard to search for and to own |
| **Clayshot** | A "clay render" is 3D slang for a grey, untextured render, which is what you block | 2 repos, unrelated | No site found for clayshot.com | **An AI video app called "Clayshot AI" is on the App Store**; also clay-pigeon shooting. Avoid |
| **Second Unit** | The film crew that shoots what the director planned: here, the model | 34 repos, including **ComfyUI-SecondUnit**, a ComfyUI node for DaVinci Resolve | Not checked; registration not checked | Same name in the same ComfyUI ecosystem, plus two VFX hackathon entries. Avoid |
| **Shotblock** | Blocking shots, said plainly | 7 repos, including **shanghaicellcenter/shotblock**, "3D shot planning & storyboards for AI filmmakers" | Not checked; registration not checked | A near-identical product already uses it. Avoid |

## Recommendation

**Pick: Greycut.** It says what the tool does (grey boxes in, a cut out), nobody on GitHub or in the
App Store uses it, it's one word that works as a repo name (`ColinWWW/greycut`), a page title and a
hashtag, and it reads well in the posts: "Greycut: block a shot with grey boxes…". Check that
greycut.com or greycut.dev is free before committing; if both are taken, the name still works without a
domain, because the live link is on GitHub Pages.

**Runner-up: Blocking Pass.** The clearest name for a VFX judge, and also unused, but two words make it
weaker as a repo name and a handle.

If one of these is picked: the repo rename (GitHub redirects the old URL), the README title and "Name
TBD", the live-link URL in the README and WRITEUP.md, the Pages base path (`BASE_PATH` in `.github/workflows/pages.yml`, `BASE` in `web/playwright.config.js`) and the `<NAME>`
placeholders in [WRITEUP.md](WRITEUP.md) all need updating, ideally before the repo goes public.
