// The expand-in-place accordion row the sidebar's list views share
// (Websites, Libraries). A <div role="button"> header — not a <button>, since
// the menu trigger has to nest inside the row's own hover box and a <button>
// can't contain another — with a disclosure chevron, a two-line label, and
// the caller-supplied menu trigger; the body below it starts hidden.

export interface AccordionRow {
  item: HTMLDivElement;
  header: HTMLDivElement;
  body: HTMLDivElement;
}

export function buildAccordionRow(
  title: string,
  subtitle: string,
  menuButton: HTMLButtonElement,
  onToggle: () => void,
): AccordionRow {
  const item = document.createElement("div");
  item.className = "accordion-item";

  const header = document.createElement("div");
  header.className = "list-item expandable";
  header.setAttribute("role", "button");
  header.tabIndex = 0;
  header.setAttribute("aria-expanded", "false");

  const disclosure = document.createElement("span");
  disclosure.className = "disclosure list-item-disclosure";

  const text = document.createElement("span");
  text.className = "list-item-text";
  const titleEl = document.createElement("span");
  titleEl.className = "list-item-title";
  titleEl.textContent = title;
  const subtitleEl = document.createElement("span");
  subtitleEl.className = "caption list-item-subtitle";
  subtitleEl.textContent = subtitle;
  text.append(titleEl, subtitleEl);

  header.append(disclosure, text, menuButton);

  const body = document.createElement("div");
  body.className = "accordion-body file-tree";
  body.hidden = true;

  header.addEventListener("click", onToggle);
  header.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle();
  });

  item.append(header, body);
  return { item, header, body };
}

export function setRowExpanded(row: Pick<AccordionRow, "header" | "body">, expanded: boolean): void {
  row.body.hidden = !expanded;
  row.header.classList.toggle("expanded", expanded);
  row.header.setAttribute("aria-expanded", String(expanded));
}
