import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Modal from "../src/components/Modal";

describe("Modal", () => {
  it("renders title and children and closes via the close button", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Создать проект" onClose={onClose}>
        <input aria-label="Имя" />
      </Modal>
    );
    expect(screen.getByText("Создать проект")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("modal-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click but not on content click", () => {
    const onClose = vi.fn();
    render(
      <Modal title="t" onClose={onClose}>
        <button type="button">inside</button>
      </Modal>
    );
    fireEvent.click(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
