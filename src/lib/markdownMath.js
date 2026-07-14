export function normalizeMathDelimiters(markdown) {
  return String(markdown || "")
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (part.startsWith("```")) return part;
      return part
        .replace(
          /\\\[([\s\S]*?)\\\]/g,
          (_match, formula) => `\n$$\n${formula}\n$$\n`
        )
        .replace(
          /\\\(([\s\S]*?)\\\)/g,
          (_match, formula) => `$${formula}$`
        );
    })
    .join("");
}
