import { KitaConsole } from "./KitaConsole";
import { getConsoleSnapshot } from "../db/console";

export default async function Home() {
  return <KitaConsole initialData={await getConsoleSnapshot()} />;
}
