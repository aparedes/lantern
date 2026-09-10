import React from "react";

export const AppBar = ({ children }: { children: React.ReactNode }) => {
  return (
    <header className="relative w-full bg-dark-charcoal text-white shadow-md">
      <div
        style={{
          flexDirection: "row",
          display: "flex",
          alignItems: "center",
          padding: 10,
        }}
      >
        {children}
      </div>
    </header>
  );
};
