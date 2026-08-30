# 09. NovelAI image API — probe results

Probe `pyserver/tools/probe_nai.py`, run 2026-08-29 against a live tier-3 (Opus) account.
**Everything in this file was observed in a response.** Where something was not measured it says so; nothing
here is filled in from memory. `app/nai.py` is written from this table, not from the vendor's documentation —
there is no published schema for image generation (see §6).

Raw bodies land in `data/nai-probe/` (numbered, one file per probe).

## 1. The host moved — use `image.novelai.net`

| Call | Result |
|---|---|
| `GET api.novelai.net/user/subscription` | **400** `"Please refresh NovelAI.net. If using a third-party tool, update to the image URL."` |
| `GET api.novelai.net/user/data` | 400, same message |
| `GET image.novelai.net/user/subscription` | **200** |

The account endpoints a third party may use are on `image.novelai.net`. `api.novelai.net/ai/generate-image`
still validates a request (its 400 is more descriptive, see §5) but the account half of it is closed, so the
studio talks to `image.novelai.net` only.

**Auth**: `Authorization: Bearer <persistent token>` (the measured token is 68 characters). Nothing else needed.

## 2. Account, Anlas and usage — one call

`GET https://image.novelai.net/user/subscription` → 200, ~441 B:

```
tier                                     3
active                                   true
expiresAt                                1789625617
accountType                              0
isGracePeriod / isPaypal                 false
paymentProcessor                         "chargebee"
perks.maxPriorityActions                 1000
perks.startPriority                      10
perks.contextTokens                      8192
perks.unlimitedMaxPriority               true
perks.moduleTrainingSteps                10000
trainingStepsLeft.fixedTrainingStepsLeft 9405     <- Anlas
trainingStepsLeft.purchasedTrainingSteps 0        <- Anlas
usage.percent                            196
usage.isNegative                         false
usage.timeUntilNextPercent               0
```

- **Anlas = `trainingStepsLeft.fixedTrainingStepsLeft + purchasedTrainingSteps`.**
- **`usage` is the v5 quota, and it is a *separate* currency from Anlas** (user, 2026-08-29 — **stated, not
  measured here**; the probe only saw the number sit still). From the v5 models on there is a usage limit that
  Anlas does not cover.
- **Whether plain generation is free depends on the subscription.** It was free throughout this probe because
  this account is Opus (tier 3); without Opus an ordinary image spends Anlas as well (user). See §4.
- **What costs on any tier**: `encode-vibe` (2) and the director tools (≈10). §7, §7b.

The panel therefore shows two numbers, not one: Anlas, and `usage.percent`. Neither is derived from the other.

Two neighbours, both 200:

- `GET /user/data` — `priority{maxPriorityActions:1250, nextRefillAt, taskPriority:10}` + the whole `subscription`
  object above + `information` + `keystore`. One call if you want priority as well.
- `GET /user/information` — `emailVerified`, `banStatus`, `accountCreatedAt`, `loginMethod`,
  **`trialActionsLeft:50`**, **`trialImagesLeft:30`**.

## 3. Generating

`POST https://image.novelai.net/ai/generate-image`

Request body — this exact shape returned 200 on both v4.5 and v5:

```json
{ "input": "<positive prompt>", "model": "<id>", "action": "generate", "parameters": { ... } }
```

`parameters` as sent and accepted:

```
params_version 3          width 832        height 1216      scale 5  (CFG)
sampler "k_euler_ancestral"                steps 23         n_samples 1
ucPreset 0                qualityToggle true                seed 12345
negative_prompt "<uc>"    cfg_rescale 0    noise_schedule "karras"
v4_prompt          { caption: { base_caption, char_captions: [] }, use_coords, use_order }
v4_negative_prompt { caption: { base_caption, char_captions: [] }, legacy_uc }
```

**Accepted as a set — not each field proven necessary.** Fields were not removed one at a time. What *is*
proven: `parameters: {}` is not enough for the v4.5/v5 models (500), and is *too much* for `nai-diffusion-3`
(it fills defaults and generates — §5).

**Response**: `200`, `content-type: binary/octet-stream`, a **ZIP** (magic `504b0304`) containing a single
entry `image_0.png`. Measured sizes: 940 597 B (v4.5), 1 270 107 B (v5). So the client unzips; it never gets
a bare PNG.

`POST /ai/generate-image/stream` — **404 on both hosts.** ~~There is no streaming variant to use.~~
**Correction (2026-08-30):** the slash path never existed, but the **hyphen** path does:
`POST image.novelai.net/ai/generate-image-stream`, the ordinary body plus `parameters.stream: "msgpack"`
and `Accept: application/x-msgpack`. The response is a raw framed binary stream — repeated
`[4-byte BE length][msgpack map]` — where `event_type: "intermediate"` carries `step_ix` and a small
preview PNG per diffusion step and `"final"` carries the finished image; errors arrive in-band as
`error`/`message` fields. Source: an external client's working implementation, not yet re-probed from
this codebase (the dev machine holds no token). `nai.generate_stream()` implements it with the ZIP path
as automatic fallback after a first failure, so a wrong detail degrades to slower, never to broken.

## 4. Cost — every number here is from a **tier 3 (Opus)** account

> **Read this before using any figure below.** Plain generation being free is an **Opus entitlement, not a
> property of the API** (user, 2026-08-29). Without an Opus subscription an ordinary image costs Anlas too.
> Every measurement in this document was taken on `tier: 3`, so the studio must **never hardcode "generation is
> free"** — it reads `GET /user/subscription` and reports what actually moved.

Three generations at 832×1216 / 23 steps / `n_samples: 1`, tier 3:

| | Anlas before | Anlas after |
|---|---|---|
| `nai-diffusion-3`, `nai-diffusion-4-5-full`, `nai-diffusion-5-full` | 9405 | **9405** |

Zero **at this tier**. `usage.percent` did not move either over three images, so whatever it counts, it is
coarse at this granularity.

What costs regardless (§7, §7b), measured one call at a time and reproduced by `probe_nai.py --vibe`:

| Call | Anlas |
|---|---|
| `encode-vibe` | **2** each (9397→9395, 9328→9326, 9261→9259 — three separate runs) |
| director tool (`augment-image`) | **≈10** each (65 for six, twice over) |
| `generate-image`, with or without a vibe attached | 0 *at tier 3* |

So the batch runner reads the balance before and after **every** batch, not only the ones it believes are
paid — that is the only way it stays honest on an account that is not this one.

## 5. Model ids — not enumerable, so check them instead

There is no endpoint that lists models, and the validator does not name the valid values
(`image.novelai.net` says `Validation error: model <id> doesn't exist`; `api.novelai.net` says
`model must be a valid enum value`). But **an absent id is rejected before anything is generated**, which makes
a free existence check possible.

**The oracle**: `POST /ai/generate-image` with `{"input":"x","model":"<id>","parameters":{"width":7,"height":7}}`
→ **400 `... doesn't exist`** = absent, **500** = present. The impossible size is load-bearing.

> With `parameters: {}` instead, `nai-diffusion-3` answered **200 with a 513 KB ZIP** — it filled in defaults
> and generated. The "free check" made a picture. That is why the oracle sends 7×7, and why the studio's
> model-check button must send it too.

Measured 2026-08-29:

| Model id | Present |
|---|---|
| `nai-diffusion-5-full` | yes |
| `nai-diffusion-5-curated` | yes |
| `nai-diffusion-4-5-full` | yes |
| `nai-diffusion-4-5-curated` | yes |
| `nai-diffusion-4-full` | yes |
| `nai-diffusion-3` | yes |
| `nai-diffusion-furry-3` | yes |
| `nai-diffusion-5`, `nai-diffusion-4-5` | **no** (the bare names are not ids) |
| `nai-diffusion-4-curated`, `nai-diffusion-5-large` | **no** |

**Consequence for the design**: model ids live in the preset JSON as data with a *check* button next to them,
never as a list in the code. The service is the list, it answers in ~330 ms, and it costs nothing.

## 5b. The PNG is the schema — every applied parameter, for free

The returned PNG carries `tEXt` chunks: `Software` (`NovelAI`), `Source`
(`NovelAI Diffusion V4.5 4BDE2A90` — model plus a build hash), `Generation_time`, `Title`, `Description`, and
**`Comment`: the whole recipe as JSON**, including every default the service applied that we never sent. So the
authoritative parameter list did not have to be guessed after all — one generated image names all of it.

Read back from our own 2026-08-29 image (`data/nai-probe/GEN_v45.zip`):

| Group | Fields |
|---|---|
| core | `prompt` `uc` `width` `height` `scale` `steps` `sampler` `seed` `n_samples` `noise_schedule` `cfg_rescale` `uncond_scale` |
| v4/v5 prompt | `v4_prompt{caption{base_caption, char_captions[]}, use_coords, use_order, legacy_uc}`, `v4_negative_prompt{…}` |
| **vibe transfer** | `reference_information_extracted_multiple[]` `reference_strength_multiple[]` `uncond_per_vibe` `wonky_vibe_correlation` |
| **director reference** | `director_reference_images` `director_reference_descriptions` `director_reference_information_extracted` `director_reference_strengths` `director_reference_secondary_strengths` |
| sampler detail | `sm` `sm_dyn` `dynamic_thresholding(+_mimic_scale,_percentile)` `skip_cfg_above_sigma` `skip_cfg_below_sigma` `prefer_brownian` `deliberate_euler_ancestral_bug` `cfg_sched_eligibility` `minimize_sigma_inf` `explike_fine_detail` `legacy_v3_extend` |
| other | `controlnet_model` `controlnet_strength` `lora_unet_weights` `lora_clip_weights` `request_type` `stream` `version` `signed_hash` `extra_passthrough_testing{…}` |

Three consequences, and they are the useful part of this whole probe:

1. **`char_captions[]` + `use_coords` is the multi-character mechanism.** NAIS3's "up to 6 characters with
   positions" is this list. A character in the studio is a `char_caption`, not a line of prose.
2. **The `*_multiple[]` naming says vibe transfer takes a *list* of references with per-item strengths**, and
   `reference_information_extracted` is the *encoded* form — which is why NAIS3 keeps an encoding cache. The
   studio should cache the same way: encode a reference once, reuse it across a batch.
3. **A NAI PNG is self-describing.** The studio can import any NAI image — including ones made elsewhere — and
   recover its exact recipe. "Make more like this one" needs no bookkeeping of ours; the sidecar JSON becomes an
   index over the PNG's own truth rather than the truth itself.

Still **unmeasured**: how a reference image is *sent* (the `Comment` shows the applied values, not the request
field names for uploading one), and what it costs. Per §2 this is the path that spends Anlas, so it is probed
before it is built.

## 6. No published schema

`image.novelai.net/openapi.json` returns 200 — but it is an **"Observability API" v1.0.0** with one path,
`POST /errtrack/track`. Nothing about images. `api.novelai.net/openapi.json` is 404 and its `/docs` is a
Swagger shell with no usable spec. Hence this file.

## 7. Vibe transfer — encoding is a separate, **paid** call

`POST https://image.novelai.net/ai/encode-vibe` — this is the step the `_information_extracted` naming implied.

```
request   { "model": "<id>", "image": "<base64 png>", "information_extracted": 1.0 }
response  200 application/binary, ~48 950 B  (the encoded vibe; `information_extracted` changes it)
missing image -> 400 "Error verifying request: image is required"
```

The encoding then rides in the generation, base64'd:

```
parameters.reference_image_multiple                 [ "<base64 of the 48KB encoding>" ]
parameters.reference_information_extracted_multiple [ 1.0 ]
parameters.reference_strength_multiple              [ 0.6 ]
```

Confirmed applied — the produced PNG's `Comment` carries those exact values back, plus `uncond_per_vibe: true`.
**A raw image in `reference_image_multiple` is a 500**: encoding is mandatory, not a convenience.

### Which models

| Model | `encode-vibe` |
|---|---|
| `nai-diffusion-4-5-full` | **200** |
| `nai-diffusion-5-full` | **500** — v5 cannot do vibe transfer (matches what the user said) |
| `nai-diffusion-3` | 400 `"This model does not support vibe transfer through this endpoint"` |

So the studio locks the reference/vibe controls when a v5 model is selected, and says why.

### Cost, measured one call at a time

| Call | Anlas |
|---|---|
| `encode-vibe` | 9397 → 9395 = **2** |
| `generate-image` **using** that encoding | 9395 → 9395 = **0** |
| plain `generate-image` (§4) | **0** |

**You pay per encode** (and on a non-Opus account you are paying for the generation too - see §4). That makes the encoding cache a cost
control rather than a speed optimisation: re-encoding one reference across a batch of thirty is thirty times
the price of encoding it once. Cache by content hash of the source image plus `information_extracted` plus the
model — all three change the output.

## 7b. Director tools — all six work

`POST https://image.novelai.net/ai/augment-image`

```
{ "req_type": "<action>", "model": "<id>", "image": "<base64 png>",
  "width": 832, "height": 1216, "prompt": "happy" }
```

Every one of these answered **200 with a ZIP**, same envelope as generation:

`emotion` · `bg-removal` · `lineart` · `declutter` · `colorize` · `sketch`

An unknown action is refused by name (`400 Model doesn't support action <name>`), which is how the list was
found.

> **The `emotion` action is not how expression sets are normally made** (user, 2026-08-29; NAIS does it the
> other way). The usual route is an **emotion preset**: a named set of scene/emotion prompt fragments sent with
> an ordinary generation, one generation per emotion, holding the character prompt, seed and vibe constant.
> That is both cheaper — a generation against ~10 Anlas for a director call — and more controllable, because
> the emotion is expressed in the prompt rather than inferred from a finished image. `augment-image` stays
> available for touch-ups; it is not the pipeline.

**Cost: ~65 Anlas for those six calls** (9393 → 9328), so roughly 10 each — not attributed per action, and
`bg-removal` returned 2.4 MB against ~0.8 MB for the others, so they are unlikely to be equal. **Director tools
are the expensive path**: five times an encode, where ordinary generation is free. The studio warns before a
batch of them and reports the actual difference afterwards.

Also present: `POST image.novelai.net/ai/upscale` (400 validation, shape unmeasured). Only on the legacy host:
`POST api.novelai.net/ai/annotate-image` — absent from `image.novelai.net`.

## 7c. Inpainting — `action: "infill"`, and it needs the inpainting model

Same endpoint as generation, different action, and **a different model**:

```
POST /ai/generate-image
{ "input": "<prompt>", "model": "<...>-inpainting", "action": "infill",
  "parameters": { …the usual…, "image": "<base64 png>", "mask": "<base64 png>",
                  "add_original_image": true } }
```

The base model refuses it by name, which is worth quoting to the user verbatim:

> `400 Model nai-diffusion-4-5-full doesn't support action infill`

Inpainting model ids exist for every generation (checked free with the §5 oracle):
`nai-diffusion-4-5-full-inpainting` · `nai-diffusion-4-5-curated-inpainting` ·
`nai-diffusion-5-full-inpainting` · `nai-diffusion-4-full-inpainting` · `nai-diffusion-3-inpainting`.
(`nai-diffusion-inpainting` is not an id.)

**The mask is a full-resolution RGB PNG and white is what gets repainted.** Measured by diffing the result
against the source: mean channel difference **22.1 inside the white rectangle and 0.0 outside it** — so with
`add_original_image: true` everything outside the mask comes back *byte-identical*. That is what makes inpaint
safe to offer on a chosen asset: it cannot quietly alter the rest of the picture.

**Cost: 0 Anlas** at tier 3 (9257 → 9257), same as generation — and subject to the same §4 caveat.

## 7d. Director reference (캐릭터 레퍼런스) — request shape, measured 2026-08-30

Probed with `probe_nai.py --charref` plus an iteration script; every fact below was answered by the
service (raw bodies in `data/nai-probe/CHARREF_*.zip`). §5b had only shown the *applied* field names
in a PNG's `Comment`; the request shape differed in two places and the error messages were the map:

1. **`director_reference_descriptions` is a list of `V4ConditionInput`, not strings.** A string 500s
   with the Go struct name spelled out (`...V4DirectorReference.director_reference_descriptions of
   type image.V4ConditionInput`). The accepted entry is the `v4_prompt` shape:
   `{"caption": {"base_caption": "...", "char_captions": []}, "legacy_uc": false}`.
2. **The strengths request field is `director_reference_strength_values`** — sending the Comment's
   name (`director_reference_strengths`) counts as absent (`...matching lengths: images=1,
   descriptions=1, informations=1, strengths=0`). The Comment echoes it back AS
   `director_reference_strengths`. `0.6` accepted; a per-item float.
3. **`director_reference_information_extracted` must be EXACTLY `[1.0]`** — the validator says so in
   words ("must be EXACTLY 1.0 for each entry at this time").
4. **The image must be fitted to the 1024×1536 (portrait) or 1536×1024 (landscape) bucket first.**
   Raw base64 PNG is correct (no separate paid encode like vibe), but any other size — 832×1216
   straight out of generation, 1024×1024, 448×448 — is a 400 from an internal encoder
   ("Error encoding v4 director references: non-200 response: 400"). Both buckets measured 200.
   A data: URL is a 500 (parsed, refused); metadata-stripped vs NAI-metadata PNG made no difference.
5. **v4.5 only.** On `nai-diffusion-5-full` the backend's own error names the architecture:
   `Post "http://invalid.prod-ai.svc.cluster.local:8081/encode-director": ... no such host` — the
   per-model internal `/encode-director` service does not exist for v5. (That 400-vs-hostname
   difference is also how we know the 4.5 encoder is real and our earlier images were the problem.)
6. **Cost: 5 Anlas per accepted generation, tier 3 (Opus) included** — measured four times in a row
   (9257→9252→…→9232), no server-side cache across identical references. This is a *certain* cost
   like vibe encodes, so the studio's estimate must count it per image, not per batch.

The accepted request, in full (only the director_* keys differ from §3's set):

```json
"parameters": { …the usual v4 set…,
  "director_reference_images": ["<base64 PNG at 1024x1536 or 1536x1024>"],
  "director_reference_descriptions": [{"caption": {"base_caption": "", "char_captions": []}, "legacy_uc": false}],
  "director_reference_information_extracted": [1.0],
  "director_reference_strength_values": [0.6]
}
```

**Fidelity and the mode caption — measured 2026-08-30 (second run), cross-checked against NAIS3.**
NAIS3 (github.com/sunanakgo/NAIS3) carries real NovelAI web captures (`tests/fixtures/nai-web-charref.json`,
2026-07-05) asserting: the UI's 충실도(fidelity) slider is sent as
`director_reference_secondary_strength_values = [1 - fidelity]` (fidelity 1 → `[0]`), and the
캐릭터/캐릭터&스타일 mode choice is the `base_caption` string (`"character"` / `"character&style"`).
Re-probed live here (`--charref … --fidelity 0.6 --charref-mode character`):

- `director_reference_secondary_strength_values: [0.4]` → **200**, and the Comment echoes
  `director_reference_secondary_strengths: [0.4]` — the value is applied, not dropped (the earlier
  run without the field showed `null` there).
- `base_caption: "character"` → 200, echoed verbatim in the Comment's descriptions.
- Still 5 Anlas (9232 → 9227).

NAIS3's enum also lists `style` / `costume` / `delta` as caption values read from the web bundle;
only `character&style` (their capture) and `character` (ours) are verified by a response.

Unmeasured still: whether a free-text description caption steers the output semantically (K4 was a
200; quality not compared), and multi-reference behaviour (all arrays must be the same length, so the
shape is clear even though only length 1 was run).

Consequence for the studio: the reference is fitted into the orientation-matching bucket **before it
reaches the backend** — the panel resizes at upload time with a canvas (the browser has one; the
release bundle has no Pillow), `nai.py` only *checks* the size (`png_size` is stdlib) and refuses
with the bucket named, and `run_python`+Pillow remains the fallback for scripted work. The per-image
5 Anlas rides the estimate as a certain cost, like vibe encodes.

## 8. What `app/nai.py` takes from this

- Base `https://image.novelai.net`, bearer token from the `api_keys` row with provider `novelai`.
- `GET /user/subscription` for the Anlas and usage line — cheap enough to show on the studio tab.
- `POST /ai/generate-image` → unzip → `image_0.png`.
- Model id and every generation parameter come from the preset JSON. The only code that knows a model id is
  the check button, and it only knows how to *ask*.
- Streaming exists after all (§3 correction): `/ai/generate-image-stream` + msgpack frames. A batch is
  still N sequential requests run as a `jobs` row - but each request can stream its intermediate frames,
  which the backend holds in memory and the panel polls (`GET /studio/job/preview`, rev-gated).
