import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import Features from "@/components/Features";
import PerformanceMetrics from "@/components/PerformanceMetrics";
import Faq from "@/components/Faq";
import Newsletter from "@/components/Newsletter";
import RecentPosts from "@/components/RecentPosts";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Hero />
        <Features />
        <PerformanceMetrics />
        <Faq />
        <Newsletter />
        {/* <RecentPosts /> */}
      </main>
      <Footer />
    </>
  );
}
