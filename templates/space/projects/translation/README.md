---
description: "A translator's job: a hotel's spring brochure from English into Latin American Spanish, with the client's style guide, AI toolkits and a query sheet."
---

# Translation

Translate a hotel's spring brochure from English into Latin American Spanish. Use the client's style guide to draft several passages together, then review the wording in the brochure paragraph by paragraph.

- [[brochure]]: the job. Each paragraph of the client's English is quoted, with a copy below it to translate over. It's tagged `#translate`, which gives it both toolkits in its Tools tab.
- [[passages.table.html]] holds the brochure's four English passages. Its **Translate selected passages** button gives you a draft for each row you tick.
- [[style-guide]]: the client's languages, voice, typographic conventions and glossary. The translation and review buttons read the guide beside the brochure or passage Table on each run. **Query client** works from the selected passage alone.
- [[queries.table.html]]: the query sheet, a Table with a row per question: the passage, the question, the client's answer, its status, the document and when it was asked.
- [[jobs.class.html]]: the job list, a Class holding every document tagged `#translate`, with its client, languages, status and due date. It links both toolkits, which is what puts their buttons on each document it holds.
- [[tools/]] holds the toolkits.
  - [[tools/translate-passages.flow.html]] reads the style guide once. Its **For Each** loop translates each selected passage and pairs the draft with the original English.
  - [[tools/translate.flow.html]]: **Translate** proposes a translation of the selection, and **Alternatives** five versions to step through, keeping the one you pick.
  - [[tools/review.flow.html]]: **Back-translate** shows what your Spanish says, word for word, and **Check terms** where it departs from the style guide; both answer under the button and change nothing. **Query client** drafts a question to the client about the selected passage and adds it to the query sheet.

## Try it

1. Open [[passages.table.html]], tick the first two rows, and click **Translate selected passages** in the Tools tab. Allow the Flow to read the Table and style guide and use AI when asked. After the first draft, click **Continue with 1 more**.
2. Read the two English passages with their Spanish drafts under the button. Check how the second draft handles “the Garden Room” against the glossary. Copy the Spanish you want to keep over the matching unquoted text in [[brochure]].
3. To work on a single passage in the brochure, select its unquoted text and click **Translate**. For the slogan, try **Alternatives** and step through the five versions to keep one.
4. Select a paragraph you've translated and click **Back-translate** or **Check terms**.
5. Select the copy of the rates line and click **Query client**: is $120 per room or per person? The question goes into `queries.table.html` beside the document, after the first click asks to write there. Note the client's answer in its row when it comes, then add what you learn to the glossary, as the answered query about the restaurant's name was.
6. Open [[jobs.class.html]] to see the job, and change its status there.

To change what the AI is told, open a toolkit in [[tools/]]: each button's prompt is the text of a Prompt node.

## Use it for another client

Give the client's documents their own folder. Copy [[style-guide]] and [[queries.table.html]] into it, keeping those filenames and the Table's columns. Edit the guide for that client and language pair, and remove the sample query row. Tag the documents `#translate`: the same buttons use the guide and query sheet beside each document, asking for access to those files on first use. Keep this example's Class and toolkits while other documents use them.

To translate a batch of English passages, also copy [[passages.table.html]] and [[tools/translate-passages.flow.html]], keeping the Flow in a `tools/` folder beside the Table. Replace the sample rows with the new client's English.

Client text is often confidential: a local model such as Ollama or LM Studio, added in Settings → AI Models, keeps it on your computer.

## Working rules

The chat copilot reads this file while a document in this folder is open, so it works by these rules too:

- Never change the client's quoted English. Translate only the copies below it.
- Follow the style guide wherever it covers a term or a convention, and raise a query rather than guess.

Delete this folder once you don't need the example or its toolkits anymore.
