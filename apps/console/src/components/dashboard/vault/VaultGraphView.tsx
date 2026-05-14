// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Maximize2, Minimize2, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

interface GraphNode {
  id: string;
  title: string;
  path: string;
  tags: string[];
  visibility: "visible" | "restricted" | "phantom" | "hidden";
}

interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  restrictedCount: number;
  truncated: boolean;
}

interface VaultGraphViewProps {
  serverDomain: string;
  project: string;
}

// Force-directed graph visualization of the vault knowledge structure.
export function VaultGraphView({ serverDomain, project }: VaultGraphViewProps) {
  const t = useTranslations("console.vault.graph");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Node positions (force-directed layout computed client-side)
  const positionsRef = useRef<Map<string, { x: number; y: number; vx: number; vy: number }>>(new Map());
  const animationRef = useRef<number>(0);

  const fetchGraph = useCallback(async (centerId?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        project,
        depth: "2",
      });
      if (centerId) params.set("center", centerId);

      const res = await fetch(
        `https://${serverDomain}/_auth/vault/graph?${params}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        console.warn("[vault-graph] HTTP", res.status);
        return;
      }
      const data: GraphData = await res.json();
      setGraphData(data);
      initializePositions(data);
    } catch (err) {
      console.error("[vault-graph] Failed to fetch:", err);
    } finally {
      setLoading(false);
    }
  }, [serverDomain, project]);

  // Initialize random positions for new nodes
  function initializePositions(data: GraphData) {
    const positions = positionsRef.current;
    const centerX = 400;
    const centerY = 300;

    for (const node of data.nodes) {
      if (!positions.has(node.id)) {
        positions.set(node.id, {
          x: centerX + (Math.random() - 0.5) * 600,
          y: centerY + (Math.random() - 0.5) * 400,
          vx: 0,
          vy: 0,
        });
      }
    }
  }

  // Force-directed layout simulation
  function simulate() {
    if (!graphData) return;

    const positions = positionsRef.current;
    const nodes = graphData.nodes;
    const edges = graphData.edges;

    // Repulsion (all nodes repel each other)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = positions.get(nodes[i]!.id);
        const b = positions.get(nodes[j]!.id);
        if (!a || !b) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = 5000 / (dist * dist);

        a.vx -= (dx / dist) * force;
        a.vy -= (dy / dist) * force;
        b.vx += (dx / dist) * force;
        b.vy += (dy / dist) * force;
      }
    }

    // Attraction (connected nodes attract)
    for (const edge of edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 100) * 0.01;

      a.vx += (dx / dist) * force;
      a.vy += (dy / dist) * force;
      b.vx -= (dx / dist) * force;
      b.vy -= (dy / dist) * force;
    }

    // Center gravity
    for (const node of nodes) {
      const pos = positions.get(node.id);
      if (!pos) continue;
      pos.vx -= (pos.x - 400) * 0.001;
      pos.vy -= (pos.y - 300) * 0.001;
    }

    // Apply velocities with damping
    for (const node of nodes) {
      const pos = positions.get(node.id);
      if (!pos) continue;
      pos.vx *= 0.9;
      pos.vy *= 0.9;
      pos.x += pos.vx;
      pos.y += pos.vy;
    }
  }

  // Render loop
  function render() {
    const canvas = canvasRef.current;
    if (!canvas || !graphData) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(offset.x + w / 2, offset.y + h / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-400, -300);

    const positions = positionsRef.current;

    // Draw edges
    for (const edge of graphData.edges) {
      const from = positions.get(edge.source);
      const to = positions.get(edge.target);
      if (!from || !to) continue;

      const targetNode = graphData.nodes.find((n) => n.id === edge.target);
      const isPhantom = targetNode?.visibility === "phantom" || targetNode?.visibility === "restricted";

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = isPhantom ? "rgba(148, 163, 184, 0.1)" : "rgba(148, 163, 184, 0.2)";
      ctx.lineWidth = 1;
      if (isPhantom) ctx.setLineDash([4, 4]);
      else ctx.setLineDash([]);
      ctx.stroke();
    }

    ctx.setLineDash([]);

    // Draw nodes
    for (const node of graphData.nodes) {
      const pos = positions.get(node.id);
      if (!pos) continue;

      const isSelected = node.id === selectedNode;
      const radius =
        node.visibility === "phantom" || node.visibility === "restricted" ? 4 : isSelected ? 8 : 6;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);

      switch (node.visibility) {
        case "visible":
          ctx.fillStyle = isSelected ? "#F4B873" : "#f97316";
          break;
        case "restricted":
          ctx.fillStyle = "rgba(148, 163, 184, 0.3)";
          break;
        case "phantom":
          ctx.fillStyle = "rgba(148, 163, 184, 0.15)";
          break;
        default:
          ctx.fillStyle = "#f97316";
      }

      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = "#f97316";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Labels (only for visible nodes)
      if (node.visibility === "visible" && node.title) {
        ctx.fillStyle = "rgba(226, 232, 240, 0.7)";
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(node.title, pos.x, pos.y + radius + 12);
      }
    }

    ctx.restore();
  }

  // Animation loop
  useEffect(() => {
    let running = true;

    function tick() {
      if (!running) return;
      simulate();
      render();
      animationRef.current = requestAnimationFrame(tick);
    }

    if (graphData && graphData.nodes.length > 0) {
      tick();
    }

    return () => {
      running = false;
      cancelAnimationFrame(animationRef.current);
    };
  }, [graphData, selectedNode, zoom, offset]);

  // Fetch on mount
  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  // Mouse handlers for pan
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setDragging(true);
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
  }, [offset]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      setOffset({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    },
    [dragging, dragStart],
  );

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  // Click to select node
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!graphData || !canvasRef.current) return;

      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left - canvas.clientWidth / 2 - offset.x) / zoom + 400;
      const my = (e.clientY - rect.top - canvas.clientHeight / 2 - offset.y) / zoom + 300;

      const positions = positionsRef.current;
      for (const node of graphData.nodes) {
        const pos = positions.get(node.id);
        if (!pos) continue;
        const dist = Math.sqrt((pos.x - mx) ** 2 + (pos.y - my) ** 2);
        if (dist < 10) {
          setSelectedNode(node.id === selectedNode ? null : node.id);
          return;
        }
      }
      setSelectedNode(null);
    },
    [graphData, selectedNode, zoom, offset],
  );

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-cream/[0.06] bg-cream/[0.01]">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => fetchGraph()}
          disabled={loading}
          title={t("refresh")}
        >
          {loading ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setZoom((z) => Math.min(z * 1.2, 3))}
          title={t("zoomIn")}
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setZoom((z) => Math.max(z / 1.2, 0.3))}
          title={t("zoomOut")}
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {graphData?.truncated && (
            <Badge className="text-[9px] px-1.5 py-0.5 rounded bg-sodium/10 text-sodium border-0">
              {t("truncated")}
            </Badge>
          )}
          <span className="text-[10px] text-cream/45">
            {graphData
              ? t("stats", { nodes: graphData.nodes.length, edges: graphData.edges.length })
              : t("loading")}
            {graphData?.restrictedCount
              ? t("restrictedSuffix", { count: graphData.restrictedCount })
              : ""}
          </span>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative">
        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-grab active:cursor-grabbing bg-transparent"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleClick}
        />

        {/* Selected node info */}
        {selectedNode && graphData && (
          <div className="absolute bottom-4 left-4 rounded-xl border border-cream/[0.06] bg-cream/[0.02] backdrop-blur-xl px-3 py-2 shadow-2xl max-w-xs">
            {(() => {
              const node = graphData.nodes.find((n) => n.id === selectedNode);
              if (!node) return null;
              return (
                <div>
                  <div className="text-sm font-medium text-cream">
                    {node.title || t("restrictedNode")}
                  </div>
                  {node.path && (
                    <div className="text-[10px] text-cream/60 mt-0.5">
                      {node.path}
                    </div>
                  )}
                  {node.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {node.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-[9px] px-1.5 py-0.5 rounded bg-sodium/10 text-sodium"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
