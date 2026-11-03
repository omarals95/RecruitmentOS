export function canStartImport(
  available: boolean,
  reviewed: boolean,
  duplicatesReviewed: boolean,
) {
  return available && reviewed && duplicatesReviewed;
}

export function fileProblem(name: string, size: number) {
  if (!/\.(pdf|doc|docx|pages|jpg|jpeg|jfif|png)$/i.test(name))
    return "Unsupported file type.";
  if (size < 1 || size > 10 * 1024 * 1024)
    return "Choose a file between 1 byte and 10 MiB.";
  return "";
}
