export function buildSlotDeltas(current, previous) {
  if (!previous) return [];
  const keys = [
    { key: "pendingDelivery", label: "Pending delivery" },
    { key: "pastDuePending", label: "Past due pending" },
    { key: "needToProcure", label: "Need to procure" },
    { key: "bookedPlants", label: "Booked plants" },
    { key: "deliveryChangedOrders", label: "Date changed orders" },
  ];
  return keys.map(({ key, label }) => {
    const cur = Number(current?.[key] ?? 0);
    const prev = Number(previous?.[key] ?? 0);
    const changePct =
      prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : cur > 0 ? 100 : 0;
    return { key, label, current: cur, previous: prev, changePct, improved: changePct <= 0 };
  });
}

export function generateSlotInsights({
  summary,
  plants,
  geoTop,
  dailyLoad,
  previousSummary,
  currentRange,
  previousRange,
}) {
  const insights = [];
  const topPlant = plants?.[0];

  if (summary.pastDuePending > 0) {
    const share = summary.pendingDelivery > 0
      ? Math.round((summary.pastDuePending / summary.pendingDelivery) * 100)
      : 0;
    insights.push({
      id: "past-due",
      severity: share >= 30 ? "warning" : "info",
      title: "Past due backlog",
      body: `${summary.pastDuePending.toLocaleString("en-IN")} plants are past delivery date and still pending (${share}% of pipeline). ${summary.pastDueExcludingRollover?.toLocaleString("en-IN") || 0} native past-due · ${summary.pastDueRolledIn?.toLocaleString("en-IN") || 0} rolled-in.`,
    });
  }

  if (summary.needToProcure > 0) {
    insights.push({
      id: "procure",
      severity: summary.needToProcure > summary.bookedPlants * 0.15 ? "warning" : "info",
      title: "Procurement gap",
      body: `Book ${summary.needToProcure.toLocaleString("en-IN")} more plants to cover booked demand vs sowed stock. Gap is ${summary.procureGapPct}% of total booked.`,
    });
  }

  if (summary.deliveryChangedOrders > 0) {
    insights.push({
      id: "date-changes",
      severity: "info",
      title: "Delivery date changes",
      body: `${summary.deliveryChangedOrders} orders (${summary.deliveryChangedPlants?.toLocaleString("en-IN") || 0} plants) had slot/date changes in ${currentRange?.label || "range"}. Review scheduling stability.`,
    });
  }

  if (summary.utilizationPct >= 90) {
    insights.push({
      id: "capacity-pressure",
      severity: "warning",
      title: "High slot utilization",
      body: `Overall utilization at ${summary.utilizationPct}% — ${summary.overbookedSlots || 0} overbooked slots. Consider capacity expansion or slot rebalancing.`,
    });
  }

  const peakDay = [...(dailyLoad || [])].sort((a, b) => b.pendingPlants - a.pendingPlants)[0];
  if (peakDay && peakDay.pendingPlants > 0) {
    insights.push({
      id: "peak-day",
      severity: "info",
      title: "Peak delivery day",
      body: `${peakDay.label || peakDay.key} has highest load: ${peakDay.pendingPlants.toLocaleString("en-IN")} plants pending across ${peakDay.orders} orders.`,
    });
  }

  const topTaluka = geoTop?.byTaluka?.[0];
  if (topTaluka && topTaluka.plants > 0) {
    insights.push({
      id: "geo-taluka",
      severity: "info",
      title: "Top taluka — pending delivery",
      body: `${topTaluka.taluka} leads with ${topTaluka.plants.toLocaleString("en-IN")} plants pending (${topTaluka.orders} orders).`,
    });
  }

  if (topPlant && topPlant.totals?.needToProcure > 0) {
    insights.push({
      id: "plant-procure",
      severity: "info",
      title: `${topPlant.plantName} procurement`,
      body: `${topPlant.plantName} needs ${topPlant.totals.needToProcure.toLocaleString("en-IN")} plants procured — highest plant-level gap.`,
    });
  }

  if (previousSummary && summary.pendingDelivery > previousSummary.pendingDelivery) {
    const pct = previousSummary.pendingDelivery > 0
      ? Math.round(((summary.pendingDelivery - previousSummary.pendingDelivery) / previousSummary.pendingDelivery) * 100)
      : 100;
    if (pct >= 10) {
      insights.push({
        id: "pipeline-growth",
        severity: "warning",
        title: "Pipeline growing",
        body: `Pending delivery up ${pct}% vs ${previousRange?.label || "prior period"} (${summary.pendingDelivery.toLocaleString("en-IN")} vs ${previousSummary.pendingDelivery.toLocaleString("en-IN")}).`,
      });
    }
  }

  return insights.slice(0, 7);
}
