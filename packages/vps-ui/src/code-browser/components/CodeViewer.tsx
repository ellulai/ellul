// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Highlight, themes } from "prism-react-renderer";
import { getFileConfig, relativeDate } from "./file-config";
import type { BlameLine } from "../types";

const LANGUAGE_MAP: Record<string, string> = {
  text: "text",
  git: "bash",
  docker: "docker",
  dockerfile: "docker",
  ini: "ini",
  toml: "toml",
  prisma: "graphql",
  erb: "markup",
  mdx: "markdown",
};

export function CodeViewer({
  code,
  language,
  blameData,
}: {
  code: string;
  language: string;
  blameData?: BlameLine[] | null;
}) {
  const mappedLanguage = LANGUAGE_MAP[language] || language;
  const showBlame = blameData && blameData.length > 0;

  return (
    <Highlight theme={themes.nightOwl} code={code} language={mappedLanguage}>
      {({ className, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={`${className} text-[13px] leading-5 overflow-auto h-full`}
          style={{ ...style, background: "transparent", margin: 0, padding: 0 }}
        >
          <code className="block min-w-full">
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line });
              const lineNum = i + 1;
              const blame = showBlame ? blameData.find((b) => b.lineNumber === lineNum) : null;
              const prevBlame = showBlame && i > 0 ? blameData.find((b) => b.lineNumber === lineNum - 1) : null;
              const isGroupContinuation = blame && prevBlame && blame.sha === prevBlame.sha;

              return (
                <div
                  key={i}
                  {...lineProps}
                  className="table-row hover:bg-secondary/30"
                  data-line={lineNum}
                >
                  {showBlame ? (
                    <span
                      className="table-cell text-right pr-2 pl-2 select-none text-[10px] text-cream/35 font-mono w-[140px] border-r border-cream/[0.04] truncate"
                      title={blame ? `${blame.sha.slice(0, 7)} ${blame.author} ${blame.date}\n${blame.summary}` : ""}
                    >
                      {blame && !isGroupContinuation
                        ? `${blame.author.slice(0, 8).padEnd(8)} ${relativeDate(blame.date)}`
                        : ""}
                    </span>
                  ) : (
                    <span className="table-cell text-right pr-4 pl-4 select-none text-cream/45 text-xs w-12">
                      {lineNum}
                    </span>
                  )}
                  <span className="table-cell pr-4">
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))}
                    {line.length === 0 && " "}
                  </span>
                </div>
              );
            })}
          </code>
        </pre>
      )}
    </Highlight>
  );
}
