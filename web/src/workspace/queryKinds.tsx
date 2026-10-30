import type { QueryDef, QueryType } from "../../../shared/model";
import { queryTypeOf } from "../engine/statements";
import {
  AppendQueryIcon,
  CrosstabQueryIcon,
  DeleteQueryIcon,
  MakeTableQueryIcon,
  QueryIcon,
  UpdateQueryIcon,
} from "../ui/icons";

export const QUERY_TYPE_ICONS: Record<QueryType, typeof QueryIcon> = {
  select: QueryIcon,
  makeTable: MakeTableQueryIcon,
  append: AppendQueryIcon,
  update: UpdateQueryIcon,
  delete: DeleteQueryIcon,
  crosstab: CrosstabQueryIcon,
};

/** A query's type comes from its SQL, so typed and imported queries are classified too. */
export function typeOfQuery(q: QueryDef): QueryType {
  if (q.mode === "design" && q.design?.type) return q.design.type;
  return q.sql.trim() ? queryTypeOf(q.sql) : (q.design?.type ?? "select");
}
