function pctChange(cur, prev) {
  if (!prev) return cur > 0 ? 100 : 0;
  return ((cur - prev) / prev) * 100;
}

function fmtL(n) {
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(0)}K`;
  return `₹${Math.round(n)}`;
}

export function generateCollectionInsights({
  current,
  previous,
  bySalesman = [],
  byVillage = [],
  delayBuckets = [],
  byPaymentMode = [],
}) {
  const insights = [];
  const c = current?.summary || {};
  const p = previous?.summary || {};

  const collRate = c.orderAmount > 0 ? (c.collectionAmount / c.orderAmount) * 100 : 0;
  const prevRate = p.orderAmount > 0 ? (p.collectionAmount / p.orderAmount) * 100 : 0;
  const recoveryDelta = pctChange(c.collectionAmount, p.collectionAmount);

  insights.push({
    id: "period-recovery",
    type: recoveryDelta >= 0 ? "success" : "warning",
    severity: Math.abs(recoveryDelta) > 15 ? "high" : "medium",
    title: "Recovery vs previous range",
    message: `Collection ${recoveryDelta >= 0 ? "up" : "down"} ${Math.abs(recoveryDelta).toFixed(1)}% (${fmtL(c.collectionAmount)} vs ${fmtL(p.collectionAmount)} prior).`,
    metric: `${recoveryDelta >= 0 ? "+" : ""}${recoveryDelta.toFixed(1)}%`,
  });

  insights.push({
    id: "collection-rate",
    type: collRate >= prevRate ? "success" : "warning",
    severity: "medium",
    title: "Collection efficiency",
    message: `Collection rate ${collRate.toFixed(1)}% vs ${prevRate.toFixed(1)}% in the previous same-length period.`,
    metric: `${collRate.toFixed(1)}%`,
  });

  const topSales = bySalesman[0];
  if (topSales) {
    const share = c.collectionAmount > 0 ? (topSales.collectionAmount / c.collectionAmount) * 100 : 0;
    insights.push({
      id: "top-salesman",
      type: "info",
      severity: "low",
      title: "Top collection performer",
      message: `${topSales.name} leads with ${fmtL(topSales.collectionAmount)} (${share.toFixed(0)}% of total recovery).`,
      metric: topSales.name,
    });
  }

  const riskVillage = [...byVillage]
    .filter((v) => v.orderAmount > 0)
    .sort((a, b) => b.outstandingAmount / b.orderAmount - a.outstandingAmount / a.orderAmount)[0];
  if (riskVillage && riskVillage.outstandingAmount > 0) {
    const overduePct = (riskVillage.outstandingAmount / riskVillage.orderAmount) * 100;
    insights.push({
      id: "village-risk",
      type: "risk",
      severity: overduePct > 50 ? "high" : "medium",
      title: "Village outstanding risk",
      message: `${riskVillage.name} has ${overduePct.toFixed(0)}% outstanding (${fmtL(riskVillage.outstandingAmount)} pending).`,
      metric: riskVillage.name,
    });
  }

  const highDelay = delayBuckets.find((b) => b._id >= 91 || b._id === "unknown");
  if (highDelay?.count > 0) {
    insights.push({
      id: "delay-risk",
      type: "risk",
      severity: "high",
      title: "Late payment pattern",
      message: `${highDelay.count} orders show >90 day collection delay — prioritize follow-up.`,
      metric: String(highDelay.count),
    });
  }

  const topMode = byPaymentMode[0];
  if (topMode) {
    insights.push({
      id: "payment-mode",
      type: "info",
      severity: "low",
      title: "Dominant payment mode",
      message: `${topMode._id} accounts for ${fmtL(topMode.amount)} across ${topMode.count} collections.`,
      metric: topMode._id,
    });
  }

  if (c.outstandingAmount > p.outstandingAmount * 1.1) {
    insights.push({
      id: "outstanding-growth",
      type: "warning",
      severity: "high",
      title: "Outstanding growth alert",
      message: `Outstanding rose to ${fmtL(c.outstandingAmount)} from ${fmtL(p.outstandingAmount)} in prior period.`,
      metric: fmtL(c.outstandingAmount),
    });
  }

  const hiddenOpportunity = [...byVillage]
    .filter((v) => v.collectionAmount > 0 && v.outstandingAmount > v.collectionAmount * 0.3)
    .sort((a, b) => b.outstandingAmount - a.outstandingAmount)[0];
  if (hiddenOpportunity) {
    insights.push({
      id: "opportunity",
      type: "opportunity",
      severity: "medium",
      title: "Recovery opportunity",
      message: `${hiddenOpportunity.name} collected ${fmtL(hiddenOpportunity.collectionAmount)} but still has ${fmtL(hiddenOpportunity.outstandingAmount)} recoverable.`,
      metric: fmtL(hiddenOpportunity.outstandingAmount),
    });
  }

  return insights;
}
