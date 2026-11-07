import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

import { AmuHelp } from "../components/settings/AmuHelp";

function SettingsGeneralRoute() {
  return (
    <>
      <AmuHelp />
      <GeneralSettingsPanel />
    </>
  );
}

export const Route = createFileRoute("/settings/general")({
  component: SettingsGeneralRoute,
});
