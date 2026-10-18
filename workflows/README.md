# Workflows

`reshoot_api.json` is not in the repo yet. Build the graph on the pod first (see
[docs/WORKFLOW_PLAN.md](../docs/WORKFLOW_PLAN.md)), then:

1. In ComfyUI, give these nodes their titles (right-click > Title):
   - Load Video → `RESHOOT_INPUT_VIDEO`
   - Reshoot Camera Move → `RESHOOT_CAMERA`
   - Positive prompt (text encode) → `RESHOOT_PROMPT`
   - Sampler / noise node that has the seed → `RESHOOT_SAMPLER`
   - Final Save Video → `RESHOOT_OUTPUT`
2. **Workflow > Export (API)** → save as `workflows/reshoot_api.json`.
3. Also save the normal UI workflow as `workflows/reshoot.json` so people can open it in ComfyUI.

Check before committing: the graph contains **no API/partner nodes** (Open Weights Only rule).
