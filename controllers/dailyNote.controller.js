import DailyNote, { MOODS } from "../models/dailyNote.model.js";
import catchAsync from "../utility/catchAsync.js";
import generateResponse from "../utility/responseFormat.js";
import AppError from "../utility/appError.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** IST calendar day YYYY-MM-DD */
export function getISTDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeTags(tags) {
  if (tags == null) return undefined;
  if (!Array.isArray(tags)) return [];
  return [
    ...new Set(
      tags
        .map((t) => String(t || "").trim().slice(0, 40))
        .filter(Boolean)
    ),
  ].slice(0, 20);
}

function assertValidDate(dateStr) {
  if (!dateStr || !DATE_RE.test(dateStr)) {
    return false;
  }
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function sanitizePayload(body = {}) {
  const title =
    body.title != null ? String(body.title).trim().slice(0, 200) : undefined;
  const content =
    body.content != null ? String(body.content).trim().slice(0, 10000) : undefined;
  let mood = body.mood;
  if (mood === "" || mood === null) mood = undefined;
  if (mood !== undefined && !MOODS.includes(mood)) {
    throw new AppError(`Invalid mood. Allowed: ${MOODS.join(", ")}`, 400);
  }
  const tags = normalizeTags(body.tags);
  return { title, content, mood, tags };
}

/**
 * GET /daily-notes/today
 */
export const getTodayNote = catchAsync(async (req, res) => {
  const noteDate = getISTDateString();
  const note = await DailyNote.findOne({
    user: req.user._id,
    noteDate,
  }).lean();

  return res.status(200).json(
    generateResponse("Success", "Today's note fetched", {
      noteDate,
      note: note || null,
      hasNote: Boolean(note),
    })
  );
});

/**
 * PUT /daily-notes/today — upsert today's note
 */
export const upsertTodayNote = catchAsync(async (req, res, next) => {
  const noteDate = getISTDateString();
  const payload = sanitizePayload(req.body);

  if (!payload.content) {
    return next(new AppError("Content is required", 400));
  }

  const update = {
    content: payload.content,
    ...(payload.title !== undefined && { title: payload.title }),
    ...(payload.mood && { mood: payload.mood }),
    ...(payload.tags !== undefined && { tags: payload.tags }),
  };
  const unset = !payload.mood && Object.prototype.hasOwnProperty.call(req.body, "mood")
    ? { mood: 1 }
    : undefined;

  const note = await DailyNote.findOneAndUpdate(
    { user: req.user._id, noteDate },
    {
      $set: update,
      $setOnInsert: { user: req.user._id, noteDate },
      ...(unset && { $unset: unset }),
    },
    { new: true, upsert: true, runValidators: true }
  ).lean();

  return res
    .status(200)
    .json(generateResponse("Success", "Today's note saved", note));
});

/**
 * POST /daily-notes — create/upsert for a specific date
 */
export const upsertNote = catchAsync(async (req, res, next) => {
  const noteDate = String(req.body.noteDate || getISTDateString()).trim();
  if (!assertValidDate(noteDate)) {
    return next(new AppError("Invalid noteDate. Use YYYY-MM-DD", 400));
  }

  const payload = sanitizePayload(req.body);
  if (!payload.content) {
    return next(new AppError("Content is required", 400));
  }

  const update = {
    content: payload.content,
    ...(payload.title !== undefined && { title: payload.title }),
    ...(payload.mood && { mood: payload.mood }),
    ...(payload.tags !== undefined && { tags: payload.tags }),
  };
  const unset = !payload.mood && Object.prototype.hasOwnProperty.call(req.body, "mood")
    ? { mood: 1 }
    : undefined;

  const note = await DailyNote.findOneAndUpdate(
    { user: req.user._id, noteDate },
    {
      $set: update,
      $setOnInsert: { user: req.user._id, noteDate },
      ...(unset && { $unset: unset }),
    },
    { new: true, upsert: true, runValidators: true }
  ).lean();

  return res.status(200).json(generateResponse("Success", "Note saved", note));
});

/**
 * GET /daily-notes/by-date/:date
 */
export const getNoteByDate = catchAsync(async (req, res, next) => {
  const noteDate = String(req.params.date || "").trim();
  if (!assertValidDate(noteDate)) {
    return next(new AppError("Invalid date. Use YYYY-MM-DD", 400));
  }

  const note = await DailyNote.findOne({
    user: req.user._id,
    noteDate,
  }).lean();

  return res.status(200).json(
    generateResponse("Success", "Note fetched", {
      noteDate,
      note: note || null,
      hasNote: Boolean(note),
    })
  );
});

/**
 * GET /daily-notes?from=&to=&page=&limit=&q=
 */
export const listNotes = catchAsync(async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const filter = { user: req.user._id };

  const from = req.query.from ? String(req.query.from).trim() : null;
  const to = req.query.to ? String(req.query.to).trim() : null;
  if (from && !assertValidDate(from)) {
    return next(new AppError("Invalid from date", 400));
  }
  if (to && !assertValidDate(to)) {
    return next(new AppError("Invalid to date", 400));
  }
  if (from || to) {
    filter.noteDate = {};
    if (from) filter.noteDate.$gte = from;
    if (to) filter.noteDate.$lte = to;
  }

  const q = req.query.q ? String(req.query.q).trim() : "";
  if (q) {
    filter.$or = [
      { title: { $regex: q, $options: "i" } },
      { content: { $regex: q, $options: "i" } },
      { tags: { $regex: q, $options: "i" } },
    ];
  }

  const [notes, total] = await Promise.all([
    DailyNote.find(filter)
      .sort({ noteDate: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    DailyNote.countDocuments(filter),
  ]);

  return res.status(200).json(
    generateResponse("Success", "Notes listed", {
      notes,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
        hasMore: skip + notes.length < total,
      },
      today: getISTDateString(),
    })
  );
});

/**
 * PUT /daily-notes/:id
 */
export const updateNote = catchAsync(async (req, res, next) => {
  const note = await DailyNote.findOne({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!note) return next(new AppError("Note not found", 404));

  const payload = sanitizePayload(req.body);
  if (payload.content !== undefined) {
    if (!payload.content) return next(new AppError("Content cannot be empty", 400));
    note.content = payload.content;
  }
  if (payload.title !== undefined) note.title = payload.title;
  if (Object.prototype.hasOwnProperty.call(req.body, "mood")) {
    note.mood = payload.mood || undefined;
    if (!payload.mood) note.set("mood", undefined);
  }
  if (payload.tags !== undefined) note.tags = payload.tags;

  if (req.body.noteDate != null) {
    const noteDate = String(req.body.noteDate).trim();
    if (!assertValidDate(noteDate)) {
      return next(new AppError("Invalid noteDate. Use YYYY-MM-DD", 400));
    }
    note.noteDate = noteDate;
  }

  await note.save();
  return res
    .status(200)
    .json(generateResponse("Success", "Note updated", note.toObject()));
});

/**
 * DELETE /daily-notes/:id
 */
export const deleteNote = catchAsync(async (req, res, next) => {
  const note = await DailyNote.findOneAndDelete({
    _id: req.params.id,
    user: req.user._id,
  }).lean();

  if (!note) return next(new AppError("Note not found", 404));

  return res
    .status(200)
    .json(generateResponse("Success", "Note deleted", note));
});
