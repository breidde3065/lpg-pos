// One-time helper: sets a real password (and optionally a new email) for a
// Super User account. Run it from the backend folder, for example:
//
//   node scripts/set-owner-password.js admin@example.com "MyNewPassword1" owner@countygas.co.ke
//
// The third value (new email) is optional.

require('dotenv/config');

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

async function main() {
  const [currentEmail, newPassword, newEmail] = process.argv.slice(2);

  if (!currentEmail || !newPassword) {
    console.log(
      'Usage: node scripts/set-owner-password.js <current-email> "<new-password>" [new-email]',
    );
    process.exitCode = 1;
    return;
  }

  if (newPassword.length < 8 || newPassword.length > 72) {
    console.log('The password must be between 8 and 72 characters.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();

  try {
    const user = await prisma.user.findUnique({
      where: { email: currentEmail.trim().toLowerCase() },
    });

    if (!user) {
      console.log('No user was found with that email address.');
      process.exitCode = 1;
      return;
    }

    if (user.role !== 'SUPER_USER') {
      console.log('That account is not a Super User, so it was left alone.');
      process.exitCode = 1;
      return;
    }

    const data = {
      passwordHash: await bcrypt.hash(newPassword, 12),
      status: 'APPROVED',
      isActive: true,
    };

    if (newEmail) {
      data.email = newEmail.trim().toLowerCase();
    }

    await prisma.user.update({ where: { id: user.id }, data });

    console.log(
      'Done. You can now sign in as ' + (data.email || user.email) + '.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Something went wrong:', error.message);
  process.exitCode = 1;
});