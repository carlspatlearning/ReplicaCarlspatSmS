import { Request, Router } from "express";
import fs from "fs/promises";
import path from "path";
import multer from "multer";
import { z } from "zod";
import { Role, ResourceType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ApiError } from "../utils/apiError";
import { asyncHandler } from "../middleware/error";
import { validate } from "../middleware/validate";
import { authenticate, authorize, ADMINS } from "../middleware/auth";
import { currentSchoolId, requireActiveSchool } from "../middleware/tenant";
import { audit } from "../middleware/audit";
import { LOCAL_UPLOAD_DIR, uploadDocument, UploadResult } from "../services/storage";

const ALLOWED_DOC_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_DOC_TYPES.includes(file.mimetype)) {
      return cb(new ApiError(400, "Only PDF or Word (.docx) documents are allowed"));
    }
    cb(null, true);
  },
});

function withAbsoluteUrl(req: Request, result: UploadResult): UploadResult {
  if (result.provider === "local" && result.url.startsWith("/")) {
    return { ...result, url: `${req.protocol}://${req.get("host")}${result.url}` };
  }
  return result;
}

function makeAbsolute(req: Request, url: string): string {
  if (url.startsWith("/")) return `${req.protocol}://${req.get("host")}${url}`;
  return url;
}

const router = Router();
router.use(authenticate, requireActiveSchool);

async function canReadResource(req: Request, classRoomId: string | null): Promise<boolean> {
  if (!classRoomId) return true;
  if (req.auth!.role === Role.PARENT) {
    const parent = await prisma.parent.findUnique({
      where: { userId: req.auth!.sub },
      include: { students: { select: { classRoomId: true } } },
    });
    return (parent?.students ?? []).some((student) => student.classRoomId === classRoomId);
  }
  if (req.auth!.role === Role.STUDENT) {
    const student = await prisma.student.findUnique({ where: { userId: req.auth!.sub } });
    return student?.classRoomId === classRoomId;
  }
  return true;
}

// POST /resources — upload up to 10 resource documents (teachers + admins)
router.post(
  "/",
  authorize(Role.TEACHER, ...ADMINS),
  docUpload.array("files", 10),
  validate(
    z.object({
      body: z.object({
        title: z.string().min(2).max(200),
        description: z.string().max(500).optional(),
        type: z.nativeEnum(ResourceType),
        classRoomId: z.string().optional(),
        subjectId: z.string().optional(),
      }),
    })
  ),
  asyncHandler(async (req, res) => {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files?.length) throw ApiError.badRequest("No files uploaded (use multipart field 'files')");
    const { title, description, type, classRoomId, subjectId } = req.body as {
      title: string; description?: string; type: ResourceType; classRoomId?: string; subjectId?: string;
    };
    const schoolId = currentSchoolId(req);
    if (classRoomId) {
      const cls = await prisma.classRoom.findUnique({ where: { id: classRoomId }, select: { schoolId: true } });
      if (!cls || cls.schoolId !== schoolId) throw ApiError.notFound("Class not found");
    }
    if (subjectId) {
      const subject = await prisma.subject.findUnique({ where: { id: subjectId }, select: { schoolId: true } });
      if (!subject || subject.schoolId !== schoolId) throw ApiError.notFound("Subject not found");
    }

    const uploads = await Promise.all(
      files.map(async (file) => ({
        file,
        uploaded: withAbsoluteUrl(req, await uploadDocument(file.buffer, "resources", file.originalname)),
      }))
    );
    const resources = [];
    for (const [index, { file, uploaded }] of uploads.entries()) {
      const resource = await prisma.resource.create({
        data: {
          schoolId,
          title: files.length === 1 ? title : `${title} — ${file.originalname}`,
          description: description ?? null,
          type,
          fileUrl: uploaded.url,
          fileName: file.originalname,
          fileSize: file.size,
          mimeType: file.mimetype,
          classRoomId: classRoomId || null,
          subjectId: subjectId || null,
          uploadedById: req.auth!.sub,
        },
        include: {
          uploadedBy: { select: { firstName: true, lastName: true } },
          classRoom: { select: { id: true, name: true } },
          subject: { select: { id: true, name: true, code: true } },
        },
      });
      resources.push(resource);
      audit(req, "resource.upload", "Resource", resource.id, { title: resource.title, type, batchIndex: index });
    }

    res.status(201).json({
      success: true,
      data: resources,
      message: `${resources.length} resource file(s) uploaded successfully`,
    });
  })
);

// GET /resources — list resources (role-filtered)
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const role = req.auth!.role;
    let classRoomFilter: { OR: object[] } | undefined;

    if (role === Role.PARENT) {
      const parent = await prisma.parent.findUnique({
        where: { userId: req.auth!.sub },
        include: { students: { select: { classRoomId: true } } },
      });
      const ids = (parent?.students ?? []).map((s) => s.classRoomId).filter(Boolean) as string[];
      classRoomFilter = { OR: [{ classRoomId: null }, { classRoomId: { in: ids } }] };
    } else if (role === Role.STUDENT) {
      const student = await prisma.student.findUnique({ where: { userId: req.auth!.sub } });
      const ids = student?.classRoomId ? [student.classRoomId] : [];
      classRoomFilter = { OR: [{ classRoomId: null }, { classRoomId: { in: ids } }] };
    }

    const { classId, subjectId, type } = req.query as Record<string, string | undefined>;

    // Staff can filter by classId/type; parents/students get server-enforced class filter only
    const where: Record<string, unknown> = { schoolId: currentSchoolId(req), ...(classRoomFilter ?? {}) };
    if (!classRoomFilter) {
      if (classId) where.classRoomId = classId;
    }
    if (type && Object.values(ResourceType).includes(type as ResourceType)) {
      where.type = type as ResourceType;
    }
    if (subjectId) where.subjectId = subjectId;

    const resources = await prisma.resource.findMany({
      where,
      include: {
        uploadedBy: { select: { firstName: true, lastName: true } },
        classRoom: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const items = resources.map((r) => ({ ...r, fileUrl: makeAbsolute(req, r.fileUrl) }));
    res.json({ success: true, data: items });
  })
);

// GET /resources/:id/download — authenticated, tenant-scoped file delivery.
// Keeping this behind the API prevents the UI from opening a stale raw storage
// URL and returning the generic JSON route error in a new browser tab.
router.get(
  "/:id/download",
  asyncHandler(async (req, res) => {
    const resource = await prisma.resource.findUnique({ where: { id: req.params.id } });
    if (!resource || resource.schoolId !== currentSchoolId(req)) throw ApiError.notFound("Resource not found");
    if (!(await canReadResource(req, resource.classRoomId))) throw ApiError.notFound("Resource not found");

    let contents: Buffer;
    if (resource.fileUrl.startsWith("/uploads/") || /^https?:\/\/[^/]+\/uploads\//.test(resource.fileUrl)) {
      const uploadPath = resource.fileUrl.startsWith("/")
        ? resource.fileUrl
        : new URL(resource.fileUrl).pathname;
      const relativePath = uploadPath.replace(/^\/uploads\//, "");
      const resolvedPath = path.resolve(LOCAL_UPLOAD_DIR, relativePath);
      const uploadsRoot = `${path.resolve(LOCAL_UPLOAD_DIR)}${path.sep}`;
      if (!resolvedPath.startsWith(uploadsRoot)) throw ApiError.notFound("Resource file is unavailable");
      try {
        contents = await fs.readFile(resolvedPath);
      } catch {
        throw ApiError.notFound("This resource file is no longer available. Ask an administrator to upload it again.");
      }
    } else {
      const upstream = await fetch(resource.fileUrl);
      if (!upstream.ok) {
        throw ApiError.notFound("This resource file is no longer available. Ask an administrator to upload it again.");
      }
      contents = Buffer.from(await upstream.arrayBuffer());
    }

    const safeName = resource.fileName.replace(/[\r\n"]/g, "_");
    res.setHeader("Content-Type", resource.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Content-Length", contents.length);
    res.send(contents);
  })
);

// DELETE /resources/bulk?classId=... — delete resources for one class.
// Teachers remain limited to their own uploads; admins may clear the class.
router.delete(
  "/bulk",
  authorize(Role.TEACHER, ...ADMINS),
  validate(z.object({ query: z.object({ classId: z.string().min(1) }) })),
  asyncHandler(async (req, res) => {
    const schoolId = currentSchoolId(req);
    const classId = req.query.classId as string;
    const classRoom = await prisma.classRoom.findUnique({
      where: { id: classId },
      select: { schoolId: true, name: true },
    });
    if (!classRoom || classRoom.schoolId !== schoolId) throw ApiError.notFound("Class not found");

    const where = {
      schoolId,
      classRoomId: classId,
      ...(req.auth!.role === Role.TEACHER ? { uploadedById: req.auth!.sub } : {}),
    };
    const result = await prisma.resource.deleteMany({ where });
    audit(req, "resource.bulk_delete", "ClassRoom", classId, { count: result.count });
    res.json({
      success: true,
      data: { count: result.count },
      message: `${result.count} resource(s) deleted from ${classRoom.name}`,
    });
  })
);

// DELETE /resources/:id — admins can delete any; teachers can only delete their own
router.delete(
  "/:id",
  authorize(Role.TEACHER, ...ADMINS),
  asyncHandler(async (req, res) => {
    const resource = await prisma.resource.findUnique({ where: { id: req.params.id } });
    if (!resource || resource.schoolId !== currentSchoolId(req)) throw ApiError.notFound("Resource not found");
    if (req.auth!.role === Role.TEACHER && resource.uploadedById !== req.auth!.sub) {
      throw ApiError.forbidden("You can only delete your own uploads");
    }
    await prisma.resource.delete({ where: { id: req.params.id } });
    audit(req, "resource.delete", "Resource", req.params.id);
    res.json({ success: true, message: "Resource deleted" });
  })
);

export default router;
