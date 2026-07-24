import { NextResponse } from "next/server";
import {
  inviteRegistrationConfigured,
  isInviteOnlyRegistration,
} from "@backend/core/security/invite-access";

export async function GET() {
  const inviteOnly = isInviteOnlyRegistration();
  return NextResponse.json(
    {
      inviteOnly,
      registrationAvailable: !inviteOnly || inviteRegistrationConfigured(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
