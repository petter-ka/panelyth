import { Notice as NoticeView } from "@panelyth/ui"
import { useNoticeStore } from "../features/clipboard/clipboard"

/** The viewer's notice (the view is shared, src/shared/ui). */
export function Notice() {
  return <NoticeView notice={useNoticeStore((s) => s.notice)} />
}
