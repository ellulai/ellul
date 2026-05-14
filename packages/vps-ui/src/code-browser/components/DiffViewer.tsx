// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { useTranslations } from "use-intl";

export function DiffViewer({ diff }: { diff: string }) {
  const tCB = useTranslations("codeBrowser");
  if (!diff || diff.trim() === "") {
    return (
      <div className="flex-1 flex items-center justify-center text-cream/45 text-sm">
        {tCB("diff.noChanges")}
      </div>
    );
  }

  const lines = diff.split("\n");
  let oldLine = 0;
  let newLine = 0;

  return (
    <pre className="text-[13px] leading-5 overflow-auto h-full font-mono" style={{ margin: 0, padding: 0 }}>
      <code className="block min-w-full">
        {lines.map((line, i) => {
          let bgClass = "";
          let textClass = "text-cream/75";
          let oldNum = "";
          let newNum = "";

          if (line.startsWith("@@")) {
            const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (match) {
              oldLine = parseInt(match[1]!, 10);
              newLine = parseInt(match[2]!, 10);
            }
            bgClass = "bg-blue-900/20";
            textClass = "text-blue-400";
          } else if (line.startsWith("+++") || line.startsWith("---")) {
            textClass = "text-cream/45";
          } else if (line.startsWith("+")) {
            bgClass = "bg-green-900/30";
            textClass = "text-green-300";
            newNum = String(newLine);
            newLine++;
          } else if (line.startsWith("-")) {
            bgClass = "bg-terra/30";
            textClass = "text-terra";
            oldNum = String(oldLine);
            oldLine++;
          } else if (oldLine > 0) {
            oldNum = String(oldLine);
            newNum = String(newLine);
            oldLine++;
            newLine++;
          }

          return (
            <div key={i} className={`table-row ${bgClass}`}>
              <span className="table-cell text-right pr-2 pl-3 select-none text-cream/35 text-xs w-10">
                {oldNum}
              </span>
              <span className="table-cell text-right pr-3 select-none text-cream/35 text-xs w-10 border-r border-cream/[0.04]">
                {newNum}
              </span>
              <span className={`table-cell pr-4 pl-3 ${textClass}`}>
                {line || " "}
              </span>
            </div>
          );
        })}
      </code>
    </pre>
  );
}
