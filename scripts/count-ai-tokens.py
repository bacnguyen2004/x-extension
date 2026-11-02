"""Count identical replay payloads with published tokenizer encodings, without API calls."""
import json
from pathlib import Path
import tiktoken

root = Path(__file__).resolve().parents[1] / "artifacts" / "token-optimization"
rows = json.loads((root / "requests.json").read_text(encoding="utf-8"))
report = {"method": "Offline token counts of message roles/content plus estimated chat framing (3/message + 3/request). Not API usage or a quality evaluation.", "encodings": {}}
for encoding in ["o200k_base", "cl100k_base"]:
    enc = tiktoken.get_encoding(encoding)
    results = []
    for row in rows:
        counts = {}
        for version in ["before", "after"]:
            requests = row[version]["requests"]
            counts[version] = sum(3 + sum(3 + len(enc.encode(m["role"], disallowed_special=())) + len(enc.encode(m["content"], disallowed_special=())) for m in req["messages"]) for req in requests)
        results.append({"id": row["id"], "kind": row["kind"], "pogo": row["pogo"], **counts,
                        "before_requests": len(row["before"]["requests"]), "after_requests": len(row["after"]["requests"]),
                        "reduction_percent": round(100 * (1 - counts["after"] / counts["before"]), 2) if counts["before"] else None})
        if row["pogo"]:
            assert row["before"] == row["after"], f"Pogo changed: {row['id']}"
        elif row["id"] not in ["empty", "duplicate"]:
            assert row["after"]["result"].get("ok") and not row["after"]["result"].get("skipped"), row["id"]
    optimized = [r for r in results if not r["pogo"]]
    before = sum(r["before"] for r in optimized)
    after = sum(r["after"] for r in optimized)
    report["encodings"][encoding] = {"before": before, "after": after, "reduction_percent": round(100 * (1 - after / before), 2), "cases": results}
    assert after / before <= 0.4, "Corpus input-token reduction fell below 60%"
(root / "comparison.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({k: {p: v[p] for p in ["before", "after", "reduction_percent"]} for k, v in report["encodings"].items()}, indent=2))
