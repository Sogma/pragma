---
description: "A translator's job: a hotel's spring brochure from English into Latin American Spanish, with the client's style guide, AI toolkits and a query sheet."
---

# Translation

A worked example for professional translators: one job, a hotel's spring brochure from English into Latin American Spanish, set up the way you'd work it. Two toolkits offer translation and review buttons that use the client's style guide, plus a button to draft questions into a query sheet. Translation suggestions appear over your text for you to accept or reject.

- [[brochure]]: the job. Each paragraph of the client's English is quoted, with a copy below it to translate over. It's tagged `#translate`, which gives it both toolkits in its Tools tab.
- [[style-guide]]: the client's languages, voice, typographic conventions and glossary. **Translate**, **Alternatives**, **Back-translate** and **Check terms** read the guide beside the document on each click, so a term you add here is used from the next click. **Query client** works from the selected passage alone.
- [[queries.table.html]]: the query sheet, a Table with a row per question: the passage, the question, the client's answer, its status, the document and when it was asked.
- [[jobs.class.html]]: the job list, a Class holding every document tagged `#translate`, with its client, languages, status and due date. It links both toolkits, which is what puts their buttons on each document it holds.
- [[tools/]]: the two toolkits, kept out of the way until you want to change one.
  - [[tools/translate.flow.html]]: **Translate** proposes a translation of the selection, and **Alternatives** five versions to step through, keeping the one you pick.
  - [[tools/review.flow.html]]: **Back-translate** shows what your Spanish says, word for word, and **Check terms** where it departs from the style guide; both answer under the button and change nothing. **Query client** drafts a question to the client about the selected passage and adds it to the query sheet.

## Try it

1. Open [[brochure]], select the copy under the first quote, and click **Translate**. Allow it to read the document and style guide and use AI when asked.
2. Select the slogan's copy and click **Alternatives**. Step through the five versions and keep one.
3. Select a paragraph you've translated and click **Back-translate** or **Check terms**.
4. Select the copy of the rates line and click **Query client**: is $120 per room or per person? The question goes into `queries.table.html` beside the document, after the first click asks to write there. Note the client's answer in its row when it comes, then add what you learn to the glossary, as the answered query about the restaurant's name was.
5. Open [[jobs.class.html]] to see the job, and change its status there.

To change what the AI is told, open a toolkit in [[tools/]]: each button's prompt is the text of a Prompt node.

## Use it for another client

Give the client's documents their own folder. Copy [[style-guide]] and [[queries.table.html]] into it, keeping those filenames and the Table's columns. Edit the guide for that client and language pair, and remove the sample query row. Tag the documents `#translate`: the same buttons use the guide and query sheet beside each document, asking for access to those files on first use. Keep this example's Class and toolkits while other documents use them.

Client text is often confidential: a local model such as Ollama or LM Studio, added in Settings → AI Models, keeps it on your computer.

## Working rules

The chat copilot reads this file while a document in this folder is open, so it works by these rules too:

- Never change the client's quoted English. Translate only the copies below it.
- Follow the style guide wherever it covers a term or a convention, and raise a query rather than guess.

Delete this folder once you don't need the example or its toolkits anymore.
