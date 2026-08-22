import { CalendarDays, Clock3, MessageSquareText, Trash2 } from "lucide-react";
import { absoluteDateTime, compact, modelOf, relativeTime, sessionDuration, sessionLifetimeTokens, sessionStatus } from "./sessionUtils";
import type { Session, Snapshot } from "./types";
import { translate } from "./i18n";
import { Empty, Modal, Status } from "./ui";

export function TaskSessionsDialog({ taskTitle, sessionIds, sessions, snapshot, onOpen, onDelete, onClose }: { taskTitle: string; sessionIds: string[]; sessions: Session[]; snapshot: Snapshot | null | undefined; onOpen: (session: Session) => void; onDelete?: (session: Session) => void; onClose: () => void }) {
  const positions = new Map(sessionIds.map((id, index) => [id, index + 1]));
  const linked = sessions
    .filter((session) => positions.has(session.id) && !session.parentID)
    .sort((left, right) => (right.time?.created ?? 0) - (left.time?.created ?? 0));
  const unavailable = Math.max(0, sessionIds.length - linked.length);
  return <Modal wide title={translate("taskSessions.title")} subtitle={translate("taskSessions.subtitle", { value0: taskTitle, count: sessionIds.length })} onClose={onClose}>
    <div className="task-session-browser">
      {linked.map((session) => {
        const created = session.time?.created;
        const duration = sessionDuration(session);
        return <article className="task-session-browser-row" key={session.id} role="button" tabIndex={0} onClick={() => onOpen(session)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpen(session); }}>
          <span className="task-session-sequence">#{positions.get(session.id)}</span>
          <span className="task-session-identity"><strong>{session.title ?? translate("common.unnamedSession")}</strong><small><CalendarDays size={12} /> {absoluteDateTime(created)} · {relativeTime(created)}</small></span>
          <span className="task-session-runtime"><strong>{session.agent ?? translate("common.default")}</strong><small>{modelOf(session)}</small></span>
          <span className="task-session-usage"><strong>{translate("sessions.tokens", { count: compact(sessionLifetimeTokens(session)) })}</strong><small><Clock3 size={12} /> {duration ?? translate("common.timeUnknown")}</small></span>
          <Status value={sessionStatus(snapshot, session)} />
          {onDelete && <button className="icon-button danger" title={translate("sessions.delete")} aria-label={translate("sessions.delete")} onClick={(event) => { event.stopPropagation(); onDelete(session); }}><Trash2 size={14} /></button>}
        </article>;
      })}
      {linked.length === 0 && <Empty icon={<MessageSquareText />} title={translate("taskSessions.empty")} detail={translate("taskSessions.emptyDetail")} />}
      {unavailable > 0 && <p className="task-session-unavailable">{translate("taskSessions.unavailable", { count: unavailable })}</p>}
    </div>
  </Modal>;
}
