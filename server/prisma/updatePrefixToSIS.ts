import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Updating school prefix to SIS in the database...");

  // 1. Update all schools where prefix is CPS or SCH to SIS
  const schools = await prisma.school.findMany();
  for (const school of schools) {
    await prisma.school.update({
      where: { id: school.id },
      data: { numberPrefix: "SIS" },
    });
    console.log(`Updated school ${school.name} (${school.id}) prefix to SIS.`);
  }

  // 2. Update all student admission numbers starting with CPS/ to SIS/
  const students = await prisma.student.findMany({
    where: {
      admissionNo: { startsWith: "CPS/" },
    },
  });

  for (const s of students) {
    const newAdmissionNo = s.admissionNo.replace(/^CPS\//, "SIS/");
    await prisma.student.update({
      where: { id: s.id },
      data: { admissionNo: newAdmissionNo },
    });
  }
  console.log(`Updated ${students.length} student admission numbers from CPS/ to SIS/.`);

  // 3. Update all teacher staff numbers starting with CPS/ to SIS/
  const teachers = await prisma.teacher.findMany({
    where: {
      staffNo: { startsWith: "CPS/" },
    },
  });

  for (const t of teachers) {
    const newStaffNo = t.staffNo.replace(/^CPS\//, "SIS/");
    await prisma.teacher.update({
      where: { id: t.id },
      data: { staffNo: newStaffNo },
    });
  }
  console.log(`Updated ${teachers.length} teacher staff numbers to SIS/.`);

  // 4. Update all payment receipt numbers starting with CPS- to SIS-
  const payments = await prisma.payment.findMany({
    where: {
      receiptNo: { startsWith: "CPS-" },
    },
  });

  for (const p of payments) {
    if (p.receiptNo) {
      const newReceiptNo = p.receiptNo.replace(/^CPS-/, "SIS-");
      await prisma.payment.update({
        where: { id: p.id },
        data: { receiptNo: newReceiptNo },
      });
    }
  }
  console.log(`Updated ${payments.length} payment receipts to SIS-.`);
  console.log("All prefixes successfully updated to SIS!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
