import Dexie from "dexie";

export const db = new Dexie("LectureFlowLocal");

db.version(1).stores({
  audioChunks: "++key,lectureId,createdAt",
  pendingSegments: "id,lectureId",
});

export async function downloadLocalAudio(
  lectureId,
  title
) {
  const chunks = await db.audioChunks
    .where("lectureId")
    .equals(lectureId)
    .sortBy("createdAt");

  if (!chunks.length) {
    throw new Error(
      "No audio found on this device for this lecture."
    );
  }

  const mime = chunks[0].mime || "audio/webm";

  const extension = mime.includes("mp4")
    ? "m4a"
    : mime.includes("ogg")
      ? "ogg"
      : "webm";

  const blob = new Blob(
    chunks.map((chunk) => chunk.blob),
    { type: mime }
  );

  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;

  const filename =
    title
      .replace(/[^a-z\d -]/gi, "")
      .trim() || "lecture";

  anchor.download = `${filename}.${extension}`;

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 15000);
}