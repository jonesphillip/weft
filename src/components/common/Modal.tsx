import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './Modal.css';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  titleBadge?: ReactNode;
  children: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'full' | 'settings';
  showBackButton?: boolean;
  onBack?: () => void;
  /** Return true to prevent close and trigger wiggle animation */
  preventClose?: () => boolean;
  /** Called when close was prevented */
  onCloseBlocked?: () => void;
}

export function Modal({ isOpen, onClose, title, titleBadge, children, width = 'md', showBackButton, onBack, preventClose, onCloseBlocked }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [isWiggling, setIsWiggling] = useState(false);

  // Reset wiggle state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setIsWiggling(false);
    }
  }, [isOpen]);

  const attemptClose = useCallback(() => {
    if (preventClose?.()) {
      // Restart animation by removing and re-adding class
      setIsWiggling(false);
      requestAnimationFrame(() => {
        setIsWiggling(true);
      });
      onCloseBlocked?.();
      return;
    }
    onClose();
  }, [preventClose, onCloseBlocked, onClose]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        attemptClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, attemptClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      attemptClose();
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className={`modal modal-${width}${isWiggling ? ' modal-wiggle' : ''}`} role="dialog" aria-modal="true">
        {title && (
          <div className="modal-header">
            <div className="modal-header-left">
              {showBackButton && onBack && (
                <button className="modal-back" onClick={onBack} aria-label="Back">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 12H5M12 19l-7-7 7-7" />
                  </svg>
                </button>
              )}
              <h2 className="modal-title">{title}</h2>
              {titleBadge}
            </div>
            <button className="modal-close" onClick={attemptClose} aria-label="Close">
              &times;
            </button>
          </div>
        )}
        <div className="modal-content">{children}</div>
      </div>
    </div>,
    document.body
  );
}
