import type { Metadata } from "next";
import { ConsumerHome } from "./ConsumerHome";

export const metadata: Metadata = {
  title: "Discover anime events near you — KitaCon",
  description: "Find conventions, concerts, pop-ups, and exhibitions connected to the fandoms you love.",
};

export default function DiscoverPage() {
  return <ConsumerHome />;
}
