# Model support

`src/server/modelSupport.json` holds what Pragma knows about the models a Generate node can send references to: how many references of each kind a model takes, and the words its prompt uses for one. Models change often, so this file changes with them; this page is how to keep it right.

## What a host does with it

- **A node's "+" stops at the model's count.** A Generate node shows its reference pins one at a time, and its "+" hides once the picked model's count of that kind is shown: `references.image`, or `references.video` for Generate Video's clips. Where the file gives a model no count of a kind, the server's catalog decides, a kind it doesn't declare counting as none; with the model on a wire, or where nothing says, the "+" stops at the nodes' pin ceiling.
- **A run sends no more than the count.** References past it are left out and reported on the node, and a prompt naming one of them fails the node.
- **A Generate Video node shows the frames the model takes.** Its `start_frame` and `end_frame` pins show for the frames in the model's `frames`, both for a model the file says nothing of, and always a wired one. A frame the node removed comes back from the "+".
- **A mention goes in the model's own words.** Each `@image_N` in a prompt is sent as the model's `mention.image`, `{n}` set to that image's place among those sent. A model with none gets the default words, `reference image {n}`.
- **The pin ceiling covers every count.** The Generate nodes declare their reference pins up to a fixed number, so no `references.image` here may exceed it; the unit suite checks this, and a model taking more needs the ceiling raised in the same change.

## Where a fact comes from

1. **The model maker's official documentation, and nothing else.** BytePlus for Seedance and Seedream, Google for Nano Banana, OpenAI for GPT Image, Kling for Kling. A reseller's page, a guide or a blog is not a source, however often it is right.
2. **The recommended form over the rest.** When a maker's docs spell a reference several ways, take the one they recommend, as Seedance's entry takes `@Image{n}`.
3. **Silence is no fact.** What the docs don't state stays out of the entry, and the host's default applies.
4. **A host passes the model's facts along until something points against it.** A host is the service Pragma sends the request to, such as Higgsfield or OpenAI's own API. It is assumed to hand the prompt and references to the model unchanged. When a host's own docs, or a run, show it doing otherwise, record that as an exception for that host, with the evidence as its source.

A docs page that renders only in a browser can often be read as text elsewhere on the maker's site: BytePlus's `docs.byteplus.com/en/docs/modelark/<page>` is also served at `ai.byteplus.com/ark/region:ap-southeast-1/docs/<page>`.

## The format

```json
{
  "$comment": "…",
  "models": {
    "Seedance 2.5": {
      "ids": ["seedance_2_5"],
      "references": { "image": 30, "video": 10, "audio": 10 },
      "frames": ["start", "end"],
      "mention": { "image": "@Image{n}", "video": "@Video{n}", "audio": "@Audio{n}" },
      "source": ["https://…", "https://…"],
      "checked": "2026-11-11",
      "hosts": {
        "mcp.example.ai": {
          "frames": [],
          "mention": { "image": null },
          "source": "what showed the host differs",
          "checked": "2026-11-11"
        }
      }
    }
  }
}
```

Each key under `models` is a model's name as its maker writes it, one entry per version: Seedance 2.0 and Seedance 2.5 take different counts, so each has its own.

| Field | Holds |
|---|---|
| `ids` | The ids hosts call the model by, such as a host's machine name (`seedance_2_5`) and the maker's API id (`gpt-image-2`). An id ending in `*` covers every id that starts with the rest (`gpt-image-*`). An exact id wins over a `*` one, and a longer `*` one over a shorter. Ids fold case, and no two entries share one. |
| `references` | For `image`, `video` and `audio`, the most of that kind one request takes, as a whole number. The Generate nodes send images, and Generate Video clips too; the audio counts come from the same docs, for a node that sends audio. |
| `frames` | The frames a video model takes as frames, `start` and `end`, which its docs offer as a first- and last-frame setting rather than as a reference. `[]` for none. |
| `mention` | For each kind, the words the model's docs use for one reference, with `{n}` where its place among those of its kind goes (`@Image{n}`). |
| `source` | The official page each fact was read from, or a list of them. Required. |
| `checked` | The day the facts were read, as `YYYY-MM-DD`. Required. |
| `hosts` | Exceptions, keyed by host. Each may give `references`, `frames` or `mention` to lay over the model's own, where `null` for a kind's mention means the default words. Each has its own `source`, the evidence, and `checked`. |

A host is named as Pragma reaches it: an MCP server by its URL's hostname (`mcp.higgsfield.ai`), and a model provider entry by its kind (`openai`, `google`) when it talks to that kind's own endpoint, otherwise by its `baseURL`'s hostname.

## Keeping it current

- **A new model in a picker** gets an entry once its maker's docs say what it takes: find the page with the reference limits and the prompt guide, then add the ids each host lists it under, the counts, the mention words, every source and the day you read them.
- **A new version of a model is a new entry.** Leave the old one while a host still offers it.
- **An old `checked` date is a prompt to read the source again.** Makers change limits without a new model name.
- **A run that shows a host treating a fact differently**, a reference ignored or a mention not understood, becomes an exception under that host, never a change to the model's own facts.
- **Run the unit suite after any edit.** It reads the shipped file and refuses a misspelt key, a count that isn't a whole number, words with no `{n}`, a fact with no source or date, and an id two entries share.
