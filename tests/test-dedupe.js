import { dedupeCandidates } from "../utility/dedupeHelper.js";

const listA = [
  { name: "A", phone: "9405679107" },
  { name: "B", phone: "9123456789" },
];
const listB = [
  { name: "C", phone: "9405679107" }, // duplicate of A
  { name: "D", phone: "9988776655" },
];

const merged = [...listA, ...listB];
const result = dedupeCandidates(merged, "91");
console.log("Unique:", result.finalTargets.length);
console.log("Duplicates:", result.duplicatesCount);
console.log("Targets:", result.finalTargets);

