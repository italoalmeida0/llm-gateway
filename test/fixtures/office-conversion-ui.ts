import { convertOfficeToMarkdown } from "../../web/src/office";

(window as any).officeConversionTest = async () => {
  const docx = new Uint8Array(await (await fetch("/office-smoke.docx")).arrayBuffer());
  const first = await convertOfficeToMarkdown(docx, "attachment.docx", "docx");
  const rtf = new TextEncoder().encode("{\\rtf1\\ansi Second document converts too.}");
  const second = await convertOfficeToMarkdown(rtf, "another.rtf", "rtf");
  return { first, second };
};
