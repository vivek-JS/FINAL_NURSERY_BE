function pctChange(cur, prev) {
  if (!prev) return cur > 0 ? 100 : 0;
  return ((cur - prev) / prev) * 100;
}

function plants(metric) {
  return metric?.plants ?? 0;
}

function orders(metric) {
  return metric?.orders ?? 0;
}

const KPI_KEYS = [
  { key: "booked", label: "Booked", higherIsBetter: true },
  { key: "dueInRange", label: "Due in range", higherIsBetter: true },
  { key: "out", label: "Dispatched", higherIsBetter: true },
  { key: "completed", label: "Completed", higherIsBetter: true },
  { key: "yetToDispatch", label: "Yet to dispatch", higherIsBetter: false },
  { key: "pastDue", label: "Past due", higherIsBetter: false },
  { key: "futureDelivery", label: "Future delivery", higherIsBetter: null },
  { key: "deliveryChanged", label: "Delivery changed", higherIsBetter: false },
];

export function buildOrderDeliveryDeltas(current = {}, previous = {}) {
  return KPI_KEYS.map(({ key, label, higherIsBetter }) => {
    const curPlants = plants(current[key]);
    const prevPlants = plants(previous[key]);
    const changePct = Math.round(pctChange(curPlants, prevPlants) * 10) / 10;
    const improved =
      higherIsBetter === null ? null : higherIsBetter ? changePct >= 0 : changePct <= 0;
    return {
      key,
      label,
      current: { plants: curPlants, orders: orders(current[key]) },
      previous: { plants: prevPlants, orders: orders(previous[key]) },
      changePct,
      improved,
    };
  });
}

export function generateOrderDeliveryInsights({
  summary,
  previousSummary,
  deltas = [],
  deliveryChanges,
  previousDeliveryChanges,
  geoTop,
  previousGeoTop,
  currentRange,
  previousRange,
}) {
  const insights = [];
  const c = summary || {};
  const p = previousSummary || {};

  const bookedDelta = deltas.find((d) => d.key === "booked");
  if (bookedDelta) {
    const dir = bookedDelta.changePct >= 0 ? "up" : "down";
    insights.push({
      id: "booking-momentum",
      type: bookedDelta.changePct >= 0 ? "success" : "warning",
      title: "Booking momentum",
      message: `Bookings ${dir} ${Math.abs(bookedDelta.changePct).toFixed(1)}% vs prior period (${bookedDelta.current.plants.toLocaleString()} vs ${bookedDelta.previous.plants.toLocaleString()} plants).`,
      metric: `${bookedDelta.changePct >= 0 ? "+" : ""}${bookedDelta.changePct.toFixed(1)}%`,
    });
  }

  const completedDelta = deltas.find((d) => d.key === "completed");
  const dueDelta = deltas.find((d) => d.key === "dueInRange");
  if (completedDelta && dueDelta && plants(c.dueInRange) > 0) {
    const curRate = (plants(c.completed) / plants(c.dueInRange)) * 100;
    const prevRate = plants(p.dueInRange) > 0 ? (plants(p.completed) / plants(p.dueInRange)) * 100 : 0;
    const rateDelta = curRate - prevRate;
    insights.push({
      id: "fulfillment-rate",
      type: rateDelta >= 0 ? "success" : "risk",
      title: "Fulfillment efficiency",
      message: `Completion rate ${curRate.toFixed(1)}% of due plants vs ${prevRate.toFixed(1)}% last period (${rateDelta >= 0 ? "+" : ""}${rateDelta.toFixed(1)} pts).`,
      metric: `${curRate.toFixed(0)}%`,
    });
  }

  const pastDueDelta = deltas.find((d) => d.key === "pastDue");
  if (pastDueDelta && pastDueDelta.current.plants > 0) {
    insights.push({
      id: "past-due-risk",
      type: pastDueDelta.changePct > 10 ? "risk" : pastDueDelta.changePct < -5 ? "success" : "warning",
      title: "Past-due backlog",
      message:
        pastDueDelta.changePct > 0
          ? `Past-due plants grew ${pastDueDelta.changePct.toFixed(1)}% — dispatch pressure building.`
          : `Past-due plants fell ${Math.abs(pastDueDelta.changePct).toFixed(1)}% — backlog easing.`,
      metric: pastDueDelta.current.plants.toLocaleString(),
    });
  }

  const ytdDelta = deltas.find((d) => d.key === "yetToDispatch");
  if (ytdDelta && Math.abs(ytdDelta.changePct) >= 8) {
    insights.push({
      id: "pipeline-bottleneck",
      type: ytdDelta.changePct > 0 ? "warning" : "success",
      title: "Pipeline queue",
      message: `Yet-to-dispatch ${ytdDelta.changePct > 0 ? "up" : "down"} ${Math.abs(ytdDelta.changePct).toFixed(1)}% — ${ytdDelta.changePct > 0 ? "capacity or dispatch lag" : "flow improving"}.`,
      metric: ytdDelta.current.plants.toLocaleString(),
    });
  }

  const curChanges = deliveryChanges?.totalChanges?.orders ?? 0;
  const prevChanges = previousDeliveryChanges?.totalChanges?.orders ?? 0;
  if (curChanges > 0 || prevChanges > 0) {
    const chgPct = pctChange(curChanges, prevChanges);
    insights.push({
      id: "delivery-changes",
      type: Math.abs(chgPct) > 25 ? "warning" : "info",
      title: "Delivery date volatility",
      message: `${curChanges} orders had delivery changes vs ${prevChanges} prior (${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(0)}%). Early: ${deliveryChanges?.byDirection?.early?.orders ?? 0}, Late: ${deliveryChanges?.byDirection?.late?.orders ?? 0}.`,
      metric: String(curChanges),
    });
  }

  const topTaluka = geoTop?.talukas?.[0];
  const prevTop = previousGeoTop?.talukas?.[0];
  if (topTaluka) {
    const share = plants(c.dueInRange) > 0 ? (topTaluka.plants / plants(c.dueInRange)) * 100 : 0;
    const shifted = prevTop && prevTop.name !== topTaluka.name;
    insights.push({
      id: "geo-concentration",
      type: share > 35 ? "warning" : "info",
      title: shifted ? "Territory shift" : "Top territory",
      message: shifted
        ? `Lead taluka changed: ${topTaluka.name} (${share.toFixed(0)}% of due) — was ${prevTop.name}.`
        : `${topTaluka.name} leads with ${topTaluka.plants.toLocaleString()} plants (${share.toFixed(0)}% of due volume).`,
      metric: topTaluka.name,
    });
  }

  const outDelta = deltas.find((d) => d.key === "out");
  if (outDelta && bookedDelta && bookedDelta.current.plants > 0) {
    const curConv = (outDelta.current.plants / bookedDelta.current.plants) * 100;
    const prevConv =
      bookedDelta.previous.plants > 0 ? (outDelta.previous.plants / bookedDelta.previous.plants) * 100 : 0;
    if (Math.abs(curConv - prevConv) >= 3) {
      insights.push({
        id: "dispatch-conversion",
        type: curConv >= prevConv ? "success" : "opportunity",
        title: "Booked → dispatched conversion",
        message: `${curConv.toFixed(1)}% of booked plants dispatched vs ${prevConv.toFixed(1)}% prior period.`,
        metric: `${(curConv - prevConv).toFixed(1)} pts`,
      });
    }
  }

  if (currentRange && previousRange) {
    insights.unshift({
      id: "period-compare",
      type: "info",
      title: "Comparison window",
      message: `${currentRange.label || currentRange.startDate} compared with ${previousRange.label || previousRange.startDate}.`,
      metric: "MoM",
    });
  }

  return insights.slice(0, 8);
}
