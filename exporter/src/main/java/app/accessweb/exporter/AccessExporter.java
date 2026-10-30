package app.accessweb.exporter;

import com.healthmarketscience.jackcess.ColumnBuilder;
import com.healthmarketscience.jackcess.DataType;
import com.healthmarketscience.jackcess.Database;
import com.healthmarketscience.jackcess.DatabaseBuilder;
import com.healthmarketscience.jackcess.DateTimeType;
import com.healthmarketscience.jackcess.IndexBuilder;
import com.healthmarketscience.jackcess.PropertyMap;
import com.healthmarketscience.jackcess.RelationshipBuilder;
import com.healthmarketscience.jackcess.Table;
import com.healthmarketscience.jackcess.TableBuilder;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Converts an export document (JSON on stdin) into a Microsoft Access .accdb file.
 *
 * Usage: java -jar access-exporter.jar &lt;output.accdb&gt; &lt; export.json
 *
 * The JSON shape is produced by server/src/export.ts:
 * {
 *   "tables": [{ "name": "...", "description": "...",
 *                "columns": [{ "name", "type", "size", "numberSize", "required",
 *                              "primaryKey", "indexed", "description", "defaultValue" }],
 *                "rows": [[v1, v2, ...], ...] }],
 *   "relationships": [{ "name", "fromTable", "fromColumn", "toTable", "toColumn", "enforce" }],
 *   "queries": [{ "name": "...", "sql": "..." }]
 * }
 *
 * Jackcess cannot write saved queries, forms or reports, so query definitions are
 * written to a table named "_SavedQueries" for the user to recreate in Access.
 */
public final class AccessExporter {

    static final String SAVED_QUERIES_TABLE = "_SavedQueries";

    private AccessExporter() {}

    public static void main(String[] args) throws Exception {
        if (args.length >= 2 && "--import".equals(args[0])) {
            try {
                AccessImporter.run(args[1], args.length > 2 ? Integer.parseInt(args[2]) : 200_000);
            } catch (Exception e) {
                System.err.println("Import failed: " + describeImportError(e));
                System.exit(1);
            }
            return;
        }
        if (args.length != 1) {
            System.err.println("Usage: java -jar access-exporter.jar <output.accdb> < export.json");
            System.err.println("       java -jar access-exporter.jar --import <input.accdb> [maxRows] > import.json");
            System.exit(2);
        }
        String json;
        try (InputStream in = System.in) {
            json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        try {
            export(new JSONObject(json), new File(args[0]));
        } catch (Exception e) {
            System.err.println("Export failed: " + e.getMessage());
            System.exit(1);
        }
    }

    /** Turns Jackcess failures into messages a user can act on. */
    static String describeImportError(Exception e) {
        String msg = String.valueOf(e.getMessage());
        String lower = msg.toLowerCase(java.util.Locale.ROOT);
        if (e instanceof UnsupportedOperationException && lower.contains("codec")) {
            return "This database is password-protected or encrypted. Remove the password in Access (File > Info > Decrypt Database) and try again.";
        }
        if (lower.contains("invalid") && lower.contains("format") || lower.contains("unsupported") && lower.contains("version")) {
            return "This doesn't look like a Microsoft Access database this tool can read (.accdb or .mdb from Access 2000 or later).";
        }
        return msg;
    }

    public static void export(JSONObject doc, File out) throws IOException {
        if (out.exists() && !out.delete()) {
            throw new IOException("Cannot overwrite " + out);
        }
        try (Database db = new DatabaseBuilder(out)
                .setFileFormat(Database.FileFormat.V2016)
                .create()) {
            db.setDateTimeType(DateTimeType.LOCAL_DATE_TIME);
            db.setAllowAutoNumberInsert(true);

            Set<String> usedNames = new HashSet<>();
            Map<String, String> tableNameMap = new HashMap<>();
            JSONArray tables = doc.optJSONArray("tables");
            if (tables != null) {
                for (int i = 0; i < tables.length(); i++) {
                    JSONObject t = tables.getJSONObject(i);
                    String original = t.getString("name");
                    String name = uniqueName(sanitizeName(original), usedNames);
                    tableNameMap.put(original, name);
                    writeTable(db, name, t);
                }
            }

            JSONArray rels = doc.optJSONArray("relationships");
            if (rels != null) {
                for (int i = 0; i < rels.length(); i++) {
                    writeRelationship(db, rels.getJSONObject(i), tableNameMap);
                }
            }

            JSONArray queries = doc.optJSONArray("queries");
            if (queries != null && queries.length() > 0) {
                writeSavedQueries(db, uniqueName(SAVED_QUERIES_TABLE, usedNames), queries);
            }
        }
    }

    private static void writeTable(Database db, String name, JSONObject t) throws IOException {
        JSONArray cols = t.getJSONArray("columns");
        TableBuilder tb = new TableBuilder(name);
        List<String> pkCols = new ArrayList<>();
        List<String> colNames = new ArrayList<>();
        List<String> colTypes = new ArrayList<>();
        Set<String> usedCols = new HashSet<>();

        for (int i = 0; i < cols.length(); i++) {
            JSONObject c = cols.getJSONObject(i);
            String colName = uniqueName(sanitizeName(c.getString("name")), usedCols);
            String type = c.getString("type");
            colNames.add(colName);
            colTypes.add(type);

            ColumnBuilder cb = new ColumnBuilder(colName);
            switch (type) {
                case "AutoNumber" -> cb.setType(DataType.LONG).setAutoNumber(true);
                case "ShortText" -> {
                    int size = Math.max(1, Math.min(255, c.optInt("size", 255)));
                    cb.setType(DataType.TEXT).setLengthInUnits(size);
                }
                case "LongText" -> cb.setType(DataType.MEMO);
                case "Number" -> cb.setType(numberType(c.optString("numberSize", "Long")));
                case "Currency" -> cb.setType(DataType.MONEY);
                case "DateTime" -> cb.setType(DataType.SHORT_DATE_TIME);
                case "YesNo" -> cb.setType(DataType.BOOLEAN);
                default -> throw new IllegalArgumentException("Unknown field type " + type + " on " + name);
            }
            if (c.optBoolean("required") && !"AutoNumber".equals(type) && !"YesNo".equals(type)) {
                cb.putProperty(PropertyMap.REQUIRED_PROP, true);
            }
            String desc = c.optString("description", "");
            if (!desc.isBlank()) {
                cb.putProperty(PropertyMap.DESCRIPTION_PROP, truncate(desc, 255));
            }
            String def = c.optString("defaultValue", "");
            if (!def.isBlank() && !"AutoNumber".equals(type)) {
                cb.putProperty(PropertyMap.DEFAULT_VALUE_PROP, accessDefault(def, type));
            }
            if (c.optBoolean("primaryKey")) {
                pkCols.add(colName);
            }
            tb.addColumn(cb);
        }

        if (!pkCols.isEmpty()) {
            tb.addIndex(new IndexBuilder(IndexBuilder.PRIMARY_KEY_NAME)
                    .addColumns(pkCols.toArray(new String[0]))
                    .setPrimaryKey());
        }
        for (int i = 0; i < cols.length(); i++) {
            JSONObject c = cols.getJSONObject(i);
            String idx = c.optString("indexed", "No");
            if (c.optBoolean("primaryKey") || "No".equals(idx)) continue;
            IndexBuilder ib = new IndexBuilder(truncate("idx_" + colNames.get(i), 64)).addColumns(colNames.get(i));
            if ("YesNoDup".equals(idx)) ib.setUnique();
            tb.addIndex(ib);
        }

        String tableDesc = t.optString("description", "");
        if (!tableDesc.isBlank()) {
            tb.putProperty(PropertyMap.DESCRIPTION_PROP, truncate(tableDesc, 255));
        }

        Table table = tb.toTable(db);

        JSONArray rows = t.optJSONArray("rows");
        if (rows == null) return;
        List<Object[]> batch = new ArrayList<>(rows.length());
        for (int r = 0; r < rows.length(); r++) {
            JSONArray row = rows.getJSONArray(r);
            Object[] values = new Object[colNames.size()];
            for (int i = 0; i < values.length; i++) {
                Object raw = i < row.length() ? row.opt(i) : null;
                values[i] = convert(raw, colTypes.get(i), cols.getJSONObject(i));
            }
            batch.add(values);
        }
        table.addRows(batch);
    }

    private static void writeRelationship(Database db, JSONObject r, Map<String, String> tableNames) throws IOException {
        String from = tableNames.get(r.getString("fromTable"));
        String to = tableNames.get(r.getString("toTable"));
        if (from == null || to == null) return;
        RelationshipBuilder rb = new RelationshipBuilder(from, to)
                .addColumns(sanitizeName(r.getString("fromColumn")), sanitizeName(r.getString("toColumn")));
        if (r.optBoolean("enforce")) {
            rb.setReferentialIntegrity();
        }
        rb.toRelationship(db);
    }

    private static void writeSavedQueries(Database db, String tableName, JSONArray queries) throws IOException {
        Table t = new TableBuilder(tableName)
                .addColumn(new ColumnBuilder("QueryName", DataType.TEXT).setLengthInUnits(64))
                .addColumn(new ColumnBuilder("SQL", DataType.MEMO))
                .putProperty(PropertyMap.DESCRIPTION_PROP,
                        "Saved queries from Access Web. Paste the SQL into a new query in SQL View to recreate each one.")
                .toTable(db);
        for (int i = 0; i < queries.length(); i++) {
            JSONObject q = queries.getJSONObject(i);
            t.addRow(truncate(q.optString("name"), 64), q.optString("sql"));
        }
    }

    private static DataType numberType(String size) {
        return switch (size) {
            case "Byte" -> DataType.BYTE;
            case "Integer" -> DataType.INT;
            case "Single" -> DataType.FLOAT;
            case "Double" -> DataType.DOUBLE;
            default -> DataType.LONG;
        };
    }

    static Object convert(Object raw, String type, JSONObject col) {
        if (raw == null || raw == JSONObject.NULL) return null;
        String s = raw.toString();
        if (s.isEmpty() && !"ShortText".equals(type) && !"LongText".equals(type)) return null;
        try {
            return switch (type) {
                case "AutoNumber" -> (int) Math.round(Double.parseDouble(s));
                case "ShortText" -> truncate(s, Math.max(1, Math.min(255, col.optInt("size", 255))));
                case "LongText" -> s;
                case "Number" -> switch (col.optString("numberSize", "Long")) {
                    case "Byte" -> (byte) Math.max(0, Math.min(255, Math.round(Double.parseDouble(s))));
                    case "Integer" -> (short) Math.round(Double.parseDouble(s));
                    case "Single" -> Float.parseFloat(s);
                    case "Double" -> Double.parseDouble(s);
                    default -> (int) Math.round(Double.parseDouble(s));
                };
                case "Currency" -> new BigDecimal(s);
                case "DateTime" -> parseDate(s);
                case "YesNo" -> raw instanceof Boolean b ? b
                        : s.equalsIgnoreCase("true") || s.equalsIgnoreCase("yes") || s.equals("1") || s.equals("-1");
                default -> s;
            };
        } catch (NumberFormatException | DateTimeParseException e) {
            // Bad data should not abort the whole export; Access would show it as blank.
            return null;
        }
    }

    static LocalDateTime parseDate(String s) {
        if (s.length() == 10) return LocalDate.parse(s).atStartOfDay();
        if (s.endsWith("Z") || s.matches(".*[+-]\\d\\d:\\d\\d$")) {
            return OffsetDateTime.parse(s).toLocalDateTime();
        }
        return LocalDateTime.parse(s.length() == 16 ? s + ":00" : s);
    }

    /** Access default values are expressions, so text needs quoting and booleans use Yes/No. */
    static String accessDefault(String def, String type) {
        String d = def.trim();
        if (d.startsWith("=")) return d.substring(1);
        return switch (type) {
            case "ShortText", "LongText" -> d.startsWith("\"") ? d : "\"" + d.replace("\"", "\"\"") + "\"";
            case "YesNo" -> (d.equalsIgnoreCase("true") || d.equalsIgnoreCase("yes") || d.equals("-1")) ? "Yes" : "No";
            case "DateTime" -> d.equalsIgnoreCase("now()") || d.equalsIgnoreCase("date()") ? d : "#" + d.replace("#", "") + "#";
            default -> d;
        };
    }

    /** Access object names: max 64 chars, no . ! ` [ ] or leading spaces, no control characters. */
    static String sanitizeName(String name) {
        String n = name == null ? "" : name.replaceAll("[.!`\\[\\]\\p{Cntrl}]", "_").strip();
        if (n.isEmpty()) n = "Field";
        return truncate(n, 64);
    }

    private static String uniqueName(String base, Set<String> used) {
        String candidate = base;
        int n = 2;
        while (!used.add(candidate.toLowerCase(Locale.ROOT))) {
            String suffix = "_" + n++;
            candidate = truncate(base, 64 - suffix.length()) + suffix;
        }
        return candidate;
    }

    private static String truncate(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }
}
