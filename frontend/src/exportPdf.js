import { jsPDF } from "jspdf";

export function exportPdf(lecture) {
  const pdf = new jsPDF({
    unit: "mm",
    format: "a4",
  });

  const margin = 18;
  const usableWidth = 210 - margin * 2;

  let y = 23;

  function write(
    text,
    size = 10,
    bold = false,
    spacing = 4
  ) {
    pdf.setFont(
      "helvetica",
      bold ? "bold" : "normal"
    );

    pdf.setFontSize(size);

    const lines = pdf.splitTextToSize(
      String(text),
      usableWidth
    );

    const lineHeight = size * 0.48;

    for (const line of lines) {
      if (y + lineHeight > 280) {
        pdf.addPage();
        y = 23;
      }

      pdf.text(line, margin, y);
      y += lineHeight;
    }

    y += spacing;
  }

  write(
    lecture.title || "Lecture Notes",
    19,
    true,
    8
  );

  write(
    new Date(
      lecture.createdAt || Date.now()
    ).toLocaleDateString(),
    9,
    false,
    9
  );

  const content =
    lecture.notesMarkdown?.trim() ||
    (lecture.transcript || [])
      .map((segment) => segment.text)
      .join("\n\n") ||
    "No transcript available.";

  for (const original of content.split("\n")) {
    const line = original
      .replace(/\*\*/g, "")
      .replace(/^[-*]\s+/, "- ");

    if (!line.trim()) {
      y += 2;
      continue;
    }

    if (line.startsWith("# ")) {
      write(line.slice(2), 15, true, 6);
    } else if (line.startsWith("## ")) {
      write(line.slice(3), 13, true, 5);
    } else if (line.startsWith("### ")) {
      write(line.slice(4), 11, true, 4);
    } else {
      write(line, 10, false, 3);
    }
  }

  const filename =
    (lecture.title || "Lecture")
      .replace(/[^a-z\d -]/gi, "")
      .trim() || "Lecture";

  pdf.save(`${filename}.pdf`);
}