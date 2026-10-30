package app.accessweb.exporter;

import com.healthmarketscience.jackcess.Column;
import com.healthmarketscience.jackcess.DataType;
import com.healthmarketscience.jackcess.Database;
import com.healthmarketscience.jackcess.DatabaseBuilder;
import com.healthmarketscience.jackcess.DateTimeType;
import com.healthmarketscience.jackcess.Index;
import com.healthmarketscience.jackcess.PropertyMap;
import com.healthmarketscience.jackcess.Relationship;
import com.healthmarketscience.jackcess.Row;
import com.healthmarketscience.jackcess.Table;
import com.healthmarketscience.jackcess.query.Query;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

/**
 * Reads a Microsoft Access .accdb/.mdb file and writes the same JSON shape the exporter
 * consumes (tables with columns and rows, relationships, queries) plus "warnings"
 * describing anything that couldn't be brought across.
 *
 * Usage: java -jar access-exporter.jar --import &lt;input.accdb&gt; [maxRows] &gt; import.json
 */
public final class AccessImporter {

    private AccessImporter() {}

    public static void run(String file, int maxRows) throws IOException {
        JSONObject doc = read(new File(file), maxRows);
        Writer out = new OutputStreamWriter(System.out, StandardCharsets.UTF_8);
        doc.write(out);
        out.flush();
    }

    public static JSONObject read(File file, int maxRows) throws IOException {
        List<String> warnings = new ArrayList<>();
        JSONArray tables = new JSONArray();
        JSONArray relationships = new JSONArray();
        JSONArray queries = new JSONArray();
        // Columns we skipped, as "Table.Column", so relationships on them can be dropped too.
        Set<String> skipped = new HashSet<>();
        Set<String> importedTables = new HashSet<>();
        int rowBudget = maxRows;
        List<JSONObject> calculatedQueries = new ArrayList<>();

        try (Database db = new DatabaseBuilder(file).setReadOnly(true).open()) {
            db.setDateTimeType(DateTimeType.LOCAL_DATE_TIME);

            for (String name : new TreeSet<>(db.getTableNames())) {
                Table table = db.getTable(name);
                if (table == null) continue;
                if (db.isLinkedTable(table)) {
                    warnings.add("Skipped linked table '" + name + "' (its data lives in another file).");
                    continue;
                }
                JSONObject t = new JSONObject();
                t.put("name", name);
                String tableDesc = str(table.getProperties().getValue(PropertyMap.DESCRIPTION_PROP));
                if (tableDesc != null) t.put("description", tableDesc);

                // (getPrimaryKeyIndex() throws when a table has no key, so look for it.)
                Set<String> pkCols = new HashSet<>();
                for (Index idx : table.getIndexes()) {
                    if (idx.isPrimaryKey()) for (Index.Column c : idx.getColumns()) pkCols.add(c.getName());
                }

                List<Column> kept = new ArrayList<>();
                List<String> types = new ArrayList<>();
                JSONArray cols = new JSONArray();
                // Calculated fields: name -> Access expression. They become columns of a saved query.
                Map<String, String> calculated = new LinkedHashMap<>();
                for (Column col : table.getColumns()) {
                    if (col.isCalculated()) {
                        String expr = str(col.getProperties().getValue(PropertyMap.EXPRESSION_PROP));
                        skipped.add(name + "." + col.getName());
                        if (expr != null) {
                            calculated.put(col.getName(), expr);
                            continue;
                        }
                    }
                    JSONObject c = describeColumn(col, pkCols.contains(col.getName()));
                    if (c == null) {
                        skipped.add(name + "." + col.getName());
                        // Access's hidden change-history column for Long Text fields isn't something users made.
                        if (col.getName().startsWith("VersionHistory_")) continue;
                        warnings.add("Skipped field '" + name + "." + col.getName() + "' (" + typeLabel(col)
                                + " fields aren't supported yet).");
                        continue;
                    }
                    c.put("indexed", indexOption(table, col));
                    cols.put(c);
                    kept.add(col);
                    types.add(c.getString("type"));
                }
                if (kept.isEmpty()) {
                    warnings.add("Skipped table '" + name + "' because none of its fields are supported.");
                    continue;
                }
                t.put("columns", cols);

                JSONArray rows = new JSONArray();
                int total = table.getRowCount();
                for (Row row : table) {
                    if (rowBudget <= 0) break;
                    JSONArray r = new JSONArray();
                    for (int i = 0; i < kept.size(); i++) r.put(toJson(row.get(kept.get(i).getName()), types.get(i)));
                    rows.put(r);
                    rowBudget--;
                }
                if (rows.length() < total) {
                    warnings.add("Only the first " + rows.length() + " of " + total + " records in '" + name
                            + "' were imported (the import limit is " + maxRows + " records in total).");
                }
                t.put("rows", rows);
                tables.put(t);
                importedTables.add(name);
                if (!calculated.isEmpty()) calculatedQueries.add(calculatedQuery(name, calculated, warnings));
            }

            for (Relationship rel : db.getRelationships()) {
                String from = rel.getFromTable().getName();
                String to = rel.getToTable().getName();
                if (!importedTables.contains(from) || !importedTables.contains(to)) continue;
                if (rel.getFromColumns().size() != 1) {
                    warnings.add("Skipped relationship '" + rel.getName() + "' (multi-field relationships aren't supported yet).");
                    continue;
                }
                String fc = rel.getFromColumns().get(0).getName();
                String tc = rel.getToColumns().get(0).getName();
                if (skipped.contains(from + "." + fc) || skipped.contains(to + "." + tc)) continue;
                // Jackcess's "from" side is the primary (one) table, the same as ours.
                JSONObject r = new JSONObject();
                r.put("fromTable", from);
                r.put("fromColumn", fc);
                r.put("toTable", to);
                r.put("toColumn", tc);
                r.put("enforce", rel.hasReferentialIntegrity());
                relationships.put(r);
            }

            for (JSONObject q : calculatedQueries) queries.put(q);

            try {
                for (Query q : db.getQueries()) {
                    if (q.isHidden() || q.getName().startsWith("~")) continue;
                    String sql;
                    try {
                        sql = q.toSQLString();
                    } catch (RuntimeException e) {
                        warnings.add("Skipped query '" + q.getName() + "' (its SQL couldn't be read).");
                        continue;
                    }
                    if (q.getType() != Query.Type.SELECT && q.getType() != Query.Type.UNION) {
                        warnings.add("Imported query '" + q.getName() + "' as text only: " + q.getType().name().toLowerCase().replace('_', ' ')
                                + " queries can't run here yet.");
                    }
                    queries.put(new JSONObject().put("name", q.getName()).put("sql", sql));
                }
            } catch (IOException | RuntimeException e) {
                warnings.add("Saved queries couldn't be read from this file.");
            }
        }

        JSONObject doc = new JSONObject();
        doc.put("tables", tables);
        doc.put("relationships", relationships);
        doc.put("queries", queries);
        doc.put("warnings", new JSONArray(warnings));
        return doc;
    }

    /**
     * Builds "<Table> with Calculated Fields": every field of the table plus its calculated fields as
     * expressions, so forms, reports and queries can use it in place of the table (the usual Access
     * pattern). A calculated field may use another one, so those references are expanded.
     */
    static JSONObject calculatedQuery(String table, Map<String, String> calculated, List<String> warnings) {
        Map<String, String> expanded = new LinkedHashMap<>();
        for (Map.Entry<String, String> e : calculated.entrySet()) {
            String expr = e.getValue();
            for (int pass = 0; pass < 5; pass++) {
                String before = expr;
                for (Map.Entry<String, String> other : calculated.entrySet()) {
                    if (other.getKey().equals(e.getKey())) continue;
                    expr = Pattern.compile("\\[" + Pattern.quote(other.getKey()) + "\\]", Pattern.CASE_INSENSITIVE)
                            .matcher(expr).replaceAll(Matcher.quoteReplacement("(" + other.getValue() + ")"));
                }
                if (expr.equals(before)) break;
            }
            expanded.put(e.getKey(), expr);
        }
        String quoted = "[" + table.replace("]", "") + "]";
        StringBuilder sql = new StringBuilder("SELECT ").append(quoted).append(".*");
        for (Map.Entry<String, String> e : expanded.entrySet()) {
            sql.append(", ").append(e.getValue()).append(" AS [").append(e.getKey().replace("]", "")).append("]");
        }
        sql.append("\nFROM ").append(quoted).append(";");
        String queryName = table + " with Calculated Fields";
        warnings.add("Calculated fields in '" + table + "' (" + String.join(", ", calculated.keySet())
                + ") are columns of the new query '" + queryName + "'. Use that query wherever you used the table's calculated fields.");
        return new JSONObject().put("name", queryName).put("sql", sql.toString());
    }

    /** Maps an Access column to our field description, or null when the type isn't supported. */
    private static JSONObject describeColumn(Column col, boolean primaryKey) throws IOException {
        JSONObject c = new JSONObject();
        c.put("name", col.getName());
        DataType dt = col.getType();
        String type;
        switch (dt) {
            case BOOLEAN -> type = "YesNo";
            case BYTE -> { type = "Number"; c.put("numberSize", "Byte"); }
            case INT -> { type = "Number"; c.put("numberSize", "Integer"); }
            case LONG -> {
                if (col.isAutoNumber()) type = "AutoNumber";
                else { type = "Number"; c.put("numberSize", "Long"); }
            }
            case FLOAT -> { type = "Number"; c.put("numberSize", "Single"); }
            case DOUBLE, NUMERIC, BIG_INT -> { type = "Number"; c.put("numberSize", "Double"); }
            case MONEY -> type = "Currency";
            case SHORT_DATE_TIME, EXT_DATE_TIME -> type = "DateTime";
            case TEXT -> { type = "ShortText"; c.put("size", Math.max(1, Math.min(255, (int) col.getLengthInUnits()))); }
            case MEMO -> type = "LongText";
            case GUID -> { type = "ShortText"; c.put("size", 38); }
            default -> { return null; } // OLE Object, Attachment, multi-value, binary, calculated...
        }
        if (col.isCalculated()) return null;
        c.put("type", type);
        if (primaryKey) c.put("primaryKey", true);

        PropertyMap props = col.getProperties();
        Object req = props.getValue(PropertyMap.REQUIRED_PROP);
        if (Boolean.TRUE.equals(req) && !"AutoNumber".equals(type) && !"YesNo".equals(type)) c.put("required", true);
        String desc = str(props.getValue(PropertyMap.DESCRIPTION_PROP));
        if (desc != null) c.put("description", truncate(desc, 255));
        String def = str(props.getValue(PropertyMap.DEFAULT_VALUE_PROP));
        if (def != null && !"AutoNumber".equals(type)) c.put("defaultValue", truncate(def, 255));
        return c;
    }

    /** Single-field, non-primary-key indexes become the field's Indexed property. */
    private static String indexOption(Table table, Column col) {
        String result = "No";
        for (Index idx : table.getIndexes()) {
            if (idx.isPrimaryKey() || idx.isForeignKey() || idx.getColumnCount() != 1) continue;
            if (!idx.getColumns().get(0).getName().equals(col.getName())) continue;
            if (idx.isUnique()) return "YesNoDup";
            result = "YesDup";
        }
        return result;
    }

    private static Object toJson(Object v, String type) {
        if (v == null) return JSONObject.NULL;
        if (v instanceof LocalDateTime dt) {
            LocalTime t = dt.toLocalTime();
            String date = dt.toLocalDate().toString();
            if (t.equals(LocalTime.MIDNIGHT)) return date;
            // A date of 1899-12-30 is how Access stores a time with no date.
            String time = t.getSecond() == 0 ? t.toString().substring(0, 5) : t.withNano(0).toString();
            return date + "T" + time;
        }
        if (v instanceof LocalDate d) return d.toString();
        if (v instanceof BigDecimal bd) return bd.doubleValue();
        if (v instanceof Boolean || v instanceof Number) return "ShortText".equals(type) || "LongText".equals(type) ? v.toString() : v;
        if (v instanceof UUID || v instanceof String) return v.toString();
        return v.toString();
    }

    private static String typeLabel(Column col) {
        return switch (col.getType()) {
            case OLE -> "OLE Object";
            case COMPLEX_TYPE -> "Attachment / multi-value";
            case BINARY -> "Binary";
            default -> col.isCalculated() ? "Calculated" : col.getType().name();
        };
    }

    private static String str(Object o) {
        if (o == null) return null;
        String s = o.toString().strip();
        return s.isEmpty() ? null : s;
    }

    private static String truncate(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }
}
