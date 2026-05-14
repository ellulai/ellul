export interface TopicCluster {
  pillar: string;
  tag: string;
  label: string;
}

export const TOPIC_CLUSTERS: TopicCluster[] = [
  { pillar: "agent-workstation", tag: "agent-workstation", label: "Agent Workstation" },
  { pillar: "always-on-ai-agent", tag: "long-running-agents", label: "Always-On Agents" },
  { pillar: "parallel-agents", tag: "parallel-agents", label: "Parallel Agents" },
];

/**
 * Returns the matching cluster for a content item based on its tags.
 * First matching tag wins.
 */
export function getClusterForContent(tags: string[]): TopicCluster | null {
  for (const tag of tags) {
    const cluster = TOPIC_CLUSTERS.find((c) => c.tag === tag);
    if (cluster) return cluster;
  }
  return null;
}

/**
 * Returns the pillar slug for a given cluster tag.
 */
export function getPillarForCluster(clusterTag: string): string {
  const cluster = TOPIC_CLUSTERS.find((c) => c.tag === clusterTag);
  if (!cluster) return "";
  return cluster.pillar;
}
