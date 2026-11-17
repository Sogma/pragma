// A style value as the DOM writes it back, to compare with one the code set.
// A style serializes what it holds, rounding a long number and dropping a
// default argument, so the expected value goes through the same serializer
// rather than being compared as the code spelled it.
export function asStyled(property: string, value: string): string {
  const probe = document.createElement("div");
  probe.style.setProperty(property, value);
  return probe.style.getPropertyValue(property);
}
