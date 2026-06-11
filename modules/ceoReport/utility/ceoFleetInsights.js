export function buildFleetDeltas(current, previous) {
  if (!previous) return [];
  const keys = [
    { key: "trips", label: "Trips" },
    { key: "plants", label: "Plants delivered" },
    { key: "orders", label: "Orders" },
    { key: "delivered", label: "Completed trips" },
    { key: "activeDrivers", label: "Active drivers" },
    { key: "activeVehicles", label: "Active vehicles" },
    { key: "villagesServed", label: "Villages served" },
  ];

  return keys.map(({ key, label }) => {
    const cur = Number(current?.[key] ?? 0);
    const prev = Number(previous?.[key] ?? 0);
    const changePct =
      prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : cur > 0 ? 100 : 0;
    return {
      key,
      label,
      current: cur,
      previous: prev,
      changePct,
      improved: key === "cancelled" ? changePct <= 0 : changePct >= 0,
    };
  });
}

export function generateFleetInsights({
  summary,
  previousSummary,
  deltas,
  topDrivers,
  topVehicles,
  topVillages,
  currentRange,
  previousRange,
}) {
  const insights = [];

  const tripDelta = deltas?.find((d) => d.key === "trips");
  if (tripDelta && Math.abs(tripDelta.changePct) >= 5) {
    insights.push({
      id: "trip-volume",
      severity: tripDelta.changePct >= 0 ? "positive" : "warning",
      title: tripDelta.changePct >= 0 ? "Fleet activity up" : "Fleet activity down",
      body: `Trips ${tripDelta.changePct >= 0 ? "rose" : "fell"} ${Math.abs(tripDelta.changePct)}% vs ${previousRange?.label || "prior period"} (${summary.trips} vs ${previousSummary?.trips ?? 0}).`,
    });
  }

  const plantDelta = deltas?.find((d) => d.key === "plants");
  if (plantDelta && Math.abs(plantDelta.changePct) >= 8) {
    insights.push({
      id: "plant-volume",
      severity: plantDelta.changePct >= 0 ? "positive" : "warning",
      title: "Delivery volume shift",
      body: `Plants moved by fleet ${plantDelta.changePct >= 0 ? "increased" : "decreased"} ${Math.abs(plantDelta.changePct)}% (${summary.plants?.toLocaleString("en-IN")} plants in ${currentRange?.label || "range"}).`,
    });
  }

  if (summary.trips > 0) {
    const rate = Math.round((summary.delivered / summary.trips) * 1000) / 10;
    if (rate < 70) {
      insights.push({
        id: "completion-rate",
        severity: "warning",
        title: "Low trip completion",
        body: `Only ${rate}% of dispatches marked DELIVERED. ${summary.inTransit + summary.loaded + summary.pending} still in pipeline.`,
      });
    } else if (rate >= 90) {
      insights.push({
        id: "completion-rate",
        severity: "positive",
        title: "Strong completion rate",
        body: `${rate}% of trips completed in range — ${summary.delivered} of ${summary.trips} dispatches delivered.`,
      });
    }
  }

  if (summary.returnedPlants > 0 || summary.damagedPlants > 0) {
    const total = summary.returnedPlants + summary.damagedPlants;
    insights.push({
      id: "returns",
      severity: total > summary.plants * 0.02 ? "warning" : "info",
      title: "Returns & damage",
      body: `${summary.returnedPlants.toLocaleString("en-IN")} returned · ${summary.damagedPlants.toLocaleString("en-IN")} damaged plants across fleet runs.`,
    });
  }

  const lead = topDrivers?.[0];
  if (lead && lead.plants > 0) {
    const share = summary.plants > 0 ? Math.round((lead.plants / summary.plants) * 100) : 0;
    if (share >= 25) {
      insights.push({
        id: "driver-concentration",
        severity: "info",
        title: "Top driver concentration",
        body: `${lead.driverName} moved ${lead.plants.toLocaleString("en-IN")} plants (${share}% of fleet volume) across ${lead.trips} trips.`,
      });
    }
  }

  const topVehicle = topVehicles?.[0];
  if (topVehicle && topVehicle.plants > 0) {
    const share = summary.plants > 0 ? Math.round((topVehicle.plants / summary.plants) * 100) : 0;
    if (share >= 20) {
      const label = topVehicle.vehicleNumber || topVehicle.vehicleName;
      insights.push({
        id: "vehicle-concentration",
        severity: "info",
        title: "Top vehicle utilization",
        body: `${label} moved ${topVehicle.plants.toLocaleString("en-IN")} plants (${share}% of fleet volume) across ${topVehicle.trips} trips · ${topVehicle.driverCount} drivers.`,
      });
    }
  }

  const topV = topVillages?.[0];
  if (topV && topV.plants > 0) {
    insights.push({
      id: "top-village",
      severity: "info",
      title: "Highest delivery village",
      body: `${topV.village}${topV.taluka ? ` (${topV.taluka})` : ""} received ${topV.plants.toLocaleString("en-IN")} plants across ${topV.trips} trips.`,
    });
  }

  if (summary.activeDrivers > 0 && summary.trips > 0) {
    const avgTrips = Math.round((summary.trips / summary.activeDrivers) * 10) / 10;
    insights.push({
      id: "driver-util",
      severity: "info",
      title: "Driver utilization",
      body: `${summary.activeDrivers} drivers · ${summary.activeVehicles} vehicles · avg ${avgTrips} trips per driver.`,
    });
  }

  return insights.slice(0, 6);
}
